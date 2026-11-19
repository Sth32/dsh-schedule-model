import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,rename,rm,symlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {applyDedicated,planDedicated} from './dedicated-session.js';

const route={provider:'deepseek-local',model:'alpha',reasoningEffort:'low'};
const oldSession='session-old';
const history={targetSessionId:oldSession,deliveredAt:'2026-11-20T12:00:00Z',messageId:'message-previous'};
async function fixture(t){
  const cwd=await mkdtemp(join(tmpdir(),'dedicated-session-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const stored={id:'schedule-exact',kind:'rrule',target:{kind:'session',sessionId:oldSession},
    updatedAt:'2026-11-20T11:00:00Z',title:'fixture',prompt:'test-only prompt',status:'active',
    scheduledAt:'2026-11-21T00:00:00Z',rrule:'unchanged local RRULE',lastDelivery:history};
  let current=stored;
  const ws={id:'workspace-one',path:cwd,title:'Project',sessionIds:[oldSession]};
  const sessions=new Map([[oldSession,{id:oldSession,cwd,agentPreset:'standard'}]]);
  const agents=new Map(),creates=[],edits=[];
  const workspaceRegistry={list:()=>[ws],archivedSessionIds:[]};
  const ctx={
    workspaceRegistry,agentPresets:{defaultId:'fallback-preset'},llm:{resolveCallConfig:async()=>{}},
    sessionPersistence:{stat:async id=>sessions.has(id)?{header:sessions.get(id)}:undefined},
    schedule:{view:async({id})=>id===stored.id?structuredClone(current):null,
      async edit(request){
        edits.push(request);
        if(request.expectedUpdatedAt!==(current.updatedAt??null))return {code:'schedule_conflict'};
        current={...current,target:request.patch.target,updatedAt:'2026-11-20T11:00:01Z'};
        return structuredClone(current);
      }},
    agents:{turnBoundaryOf:()=>({lastTurn:0,openTurnStartSeq:null})},
    sessions:{flush:async()=>true},
    sessionController:{
      async create(args){
        creates.push(args);
        const id=args.sessionId;
        const session={id,header:{id,cwd:args.workspaceId===ws.id?ws.path:args.cwd,agentPreset:args.agentPreset}};
        let selected;
        const inbox={nextTurn:[],nextStep:[]};
        const agent={session,inbox,status:'idle',model:{select:value=>selected=value,current:()=>selected},
          runMaintenance:async fn=>fn(new AbortController().signal)};
        sessions.set(id,session.header);agents.set(id,agent);
        if(args.workspaceId)ws.sessionIds.push(id);
        return {sessionId:id,agentPreset:args.agentPreset};
      },
      async resolveAgent(id){return {agent:agents.get(id)};},
      async projections({sessionId}){
        return {kind:'sequenced',values:{agentPreset:sessions.get(sessionId)?.agentPreset,
          modelSelection:{next:agents.get(sessionId)?.model.current()}}};
      },
    },
  };
  return {cwd,ctx,stored,ws,sessions,agents,creates,edits,
    plan:(choice=route,options)=>planDedicated(ctx,stored,choice,undefined,options),
    get current(){return current;},set current(value){current=value;}};
}

test('preflight is passive; apply uses native target-only CAS and does not mutate old Session/history',async t=>{
  const f=await fixture(t);
  const result=await f.plan();
  assert.equal(result.ok,true);
  assert.equal(result.impact.workspaceTitle,'Project');
  assert.doesNotMatch(JSON.stringify(result),/test-only prompt|dedicated-session-/);
  assert.deepEqual([f.creates.length,f.edits.length],[0,0]);
  const moved=await applyDedicated(f.ctx,result.plan);
  assert.equal(moved.ok,true);
  assert.notEqual(moved.sessionId,oldSession);
  assert.deepEqual(f.creates,[{sessionId:moved.sessionId,workspaceId:f.ws.id,agentPreset:'standard'}]);
  assert.deepEqual(f.edits,[{id:f.stored.id,action:'update',expectedUpdatedAt:f.stored.updatedAt,
    patch:{target:{kind:'session',sessionId:moved.sessionId}}}]);
  assert.equal(f.current.rrule,f.stored.rrule);
  assert.equal(f.current.scheduledAt,f.stored.scheduledAt);
  assert.deepEqual(f.current.lastDelivery,history);
  assert.deepEqual(f.agents.get(moved.sessionId).model.current(),route);
  assert.equal(f.agents.has(oldSession),false);
  assert.deepEqual(await applyDedicated(f.ctx,result.plan),{ok:false,code:'invalid_plan'});
});

test('conflicting preset pin, active delivery and changed native state refuse before creation',async t=>{
  const f=await fixture(t);
  assert.equal((await f.plan(route,{routes:new Map([['standard',{...route,model:'other'}]])})).code,'source_preset_pins_different_route');
  f.current={...f.stored,executionActive:true};
  assert.equal((await f.plan()).code,'task_delivery_active');
  f.current=f.stored;
  const {plan}=await f.plan();
  f.current={...f.stored,scheduledAt:'2026-11-22T00:00:00Z'};
  assert.equal((await applyDedicated(f.ctx,plan)).code,'stale_or_active_task');
  assert.deepEqual([f.creates.length,f.edits.length],[0,0]);
});

test('flush failure or management scope loss never retargets and discloses only the recoverable draft',async t=>{
  const f=await fixture(t);
  let plan=(await f.plan()).plan;
  f.ctx.sessions.flush=async()=>false;
  const failure=await applyDedicated(f.ctx,plan);
  assert.equal(failure.code,'new_session_route_not_persisted');
  assert.ok(f.sessions.has(failure.unattachedDraft));
  assert.equal(f.edits.length,0);
  plan=(await f.plan()).plan;
  let count=0;
  f.ctx.sessions.flush=async()=>true;
  const stale=await applyDedicated(f.ctx,plan,undefined,{verifyScope:()=>++count===1});
  assert.equal(stale.code,'management_scope_changed');
  assert.ok(stale.unattachedDraft);
  assert.equal(f.edits.length,0);
});

test('CAS refusal and unknown native commit are distinguished; never delete or revert by guessing',async t=>{
  const f=await fixture(t);
  const plan=(await f.plan()).plan;
  f.ctx.schedule.edit=async()=>({code:'schedule_conflict'});
  assert.equal((await applyDedicated(f.ctx,plan)).code,'native_schedule_conflict');
  const unknown=(await f.plan()).plan;
  f.ctx.schedule.edit=async()=>{throw Error('outcome unknown');};
  const result=await applyDedicated(f.ctx,unknown);
  assert.equal(result.code,'retarget_outcome_unknown');
  assert.ok(result.possibleTarget);
  assert.equal(result.unattachedDraft,undefined);
  assert.equal(f.current.target.sessionId,oldSession);
});


test('unknown preset is refused, and a known plugin pin must match exactly',async t=>{
  const f=await fixture(t);
  f.sessions.get(oldSession).agentPreset='external-custom';
  assert.equal((await f.plan()).code,'source_preset_route_not_audited');
  assert.equal((await f.plan(route,{routes:new Map([['external-custom',{...route,reasoningEffort:'high'}]])})).code,
    'source_preset_pins_different_route');
  assert.equal((await f.plan(route,{routes:new Map([['external-custom',route]])})).ok,true);
});

const aliasType=process.platform==='win32'?'junction':'dir';

test('native bound Workspace aliases map to the exact canonical working directory through both Sessions',async t=>{
  const f=await fixture(t);
  const target=join(f.cwd,'The long native workspace directory');
  const alias=join(f.cwd,'Alternate registered spelling');
  await mkdir(target);
  await symlink(await realpath(target),alias,aliasType);
  f.ws.path=alias;
  f.sessions.get(oldSession).cwd=await realpath(target);
  const approved=await f.plan();
  assert.equal(approved.ok,true,JSON.stringify(approved));
  assert.equal(approved.impact.workspaceId,f.ws.id);
  const result=await applyDedicated(f.ctx,approved.plan);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(f.creates[0].workspaceId,f.ws.id);
  assert.equal(await realpath(f.sessions.get(result.sessionId).cwd),await realpath(target));
  assert.equal(f.edits.length,1);
});

test('missing, different or merely prefix-related Workspace paths are not treated as aliases',async t=>{
  const f=await fixture(t);
  const unrelated=join(f.cwd,'Different directory nested in workspace');
  await mkdir(unrelated);
  for(const path of [unrelated,join(f.cwd,'Missing directory')]){
    f.ws.path=path;
    assert.equal((await f.plan()).code,'source_workspace_unavailable');
  }
  assert.equal(f.creates.length,0);
  assert.equal(f.edits.length,0);
});

test('an approved binding is revalidated if removed or its alias is rebound before commit',async t=>{
  const f=await fixture(t);
  const approvedRoot=join(f.cwd,'Approved');
  const otherRoot=join(f.cwd,'Other');
  const alias=join(f.cwd,'Workspace alias');
  await Promise.all([mkdir(approvedRoot),mkdir(otherRoot)]);
  await symlink(await realpath(approvedRoot),alias,aliasType);
  f.ws.path=alias;
  f.sessions.get(oldSession).cwd=await realpath(approvedRoot);
  let approved=await f.plan();
  assert.equal(approved.ok,true);
  f.ws.sessionIds.length=0;
  let result=await applyDedicated(f.ctx,approved.plan);
  assert.equal(result.code,'source_location_changed');
  assert.equal(f.creates.length,0);
  f.ws.sessionIds.push(oldSession);
  approved=await f.plan();
  let scopeChecks=0;
  result=await applyDedicated(f.ctx,approved.plan,undefined,{verifyScope:async()=>{
    if(++scopeChecks===2){
      // Rename the *alias*, not its target: the approved real target still exists.
      await rename(alias,join(f.cwd,'Old alias'));
      await symlink(await realpath(otherRoot),alias,aliasType);
    }
    return true;
  }});
  assert.equal(result.code,'source_location_changed');
  assert.ok(result.unattachedDraft);
  assert.equal(f.edits.length,0);
  assert.equal(f.current.target.sessionId,oldSession);
});

test('Windows short-name workspace path retains exact native binding', {skip:process.platform!=='win32'}, async t=>{
  const f=await fixture(t);
  const long=join(f.cwd,'Long workspace folder for short path test');
  await mkdir(long);
  const script=`
Add-Type -Name ShortPath -Namespace DshPathTest -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
public static extern uint GetShortPathName(string longPath, System.Text.StringBuilder shortPath, uint bufferLength);
'@
$buffer = New-Object System.Text.StringBuilder 4096
$size = [DshPathTest.ShortPath]::GetShortPathName($env:DSH_TEST_LONG_WORKSPACE, $buffer, 4096)
if ($size -gt 0 -and $size -lt 4096) { $buffer.ToString() }
`;
  let short;
  try{
    const {stdout}=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,DSH_TEST_LONG_WORKSPACE:long},timeout:10000});
    short=stdout.trim();
  }catch{t.skip('Windows GetShortPathName unavailable in this runner');return;}
  if(!short||short.toLowerCase()===long.toLowerCase()||!short.split('\\').at(-1)?.includes('~')){
    t.skip('8.3 short-name creation is disabled or unavailable on this volume');return;
  }
  f.ws.path=short;
  f.sessions.get(oldSession).cwd=long;
  const approved=await f.plan();
  assert.equal(approved.ok,true,JSON.stringify(approved));
  const result=await applyDedicated(f.ctx,approved.plan);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(f.creates[0].workspaceId,f.ws.id);
});

test('same canonical spelling cannot hide replacement by a different physical directory',async t=>{
  const f=await fixture(t);
  const target=join(f.cwd,'Registered workspace');
  await mkdir(target);
  f.ws.path=target;
  f.sessions.get(oldSession).cwd=target;
  const approved=await f.plan();
  assert.equal(approved.ok,true);
  await rename(target,join(f.cwd,'Original directory retained for test'));
  await mkdir(target);
  const result=await applyDedicated(f.ctx,approved.plan);
  assert.equal(result.code,'source_location_changed');
  assert.equal(f.creates.length,0);
  assert.equal(f.edits.length,0);
});

test('new candidate cannot retarget after losing its approved native workspace membership',async t=>{
  const f=await fixture(t);
  const approved=await f.plan();
  let checks=0;
  const result=await applyDedicated(f.ctx,approved.plan,undefined,{verifyScope:()=>{
    if(++checks===2)f.ws.sessionIds.splice(1);
    return true;
  }});
  assert.equal(result.code,'new_session_location_unverified');
  assert.ok(result.unattachedDraft);
  assert.equal(f.edits.length,0);
});

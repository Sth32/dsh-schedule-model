import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduleOverrides } from './schedule-override.js';

const id='schedule-test';
const owner='session-owner';
const delivery='session-run';
const route={provider:'deepseek-test',model:'alpha',reasoningEffort:'low'};

function fakeAgent(sessionId=delivery){
  const agent={session:{id:sessionId,header:{}},status:'idle',inbox:{nextTurn:[],nextStep:[]},
    selections:[],options:{},before:{provider:'fallback',model:'legacy'}};
  agent.model={current:()=>agent.selections.at(-1)??agent.before,select:selected=>agent.selections.push(selected)};
  return agent;
}

async function fixture(t,matchingTask){
  const dir=await mkdtemp(join(tmpdir(),'dsh-override-'));
  t.after(()=>rm(dir,{force:true,recursive:true}));
  const target={kind:'new',create:{cwd:'/keep-cwd',agentPreset:'ptc-preset'}};
  const task={id,title:'test',target,timing:{kind:'rrule',rrule:'UNCHANGED'},involvedSessionIds:[owner]};
  const stored={record:{id},target:structuredClone(target),pendingDelivery:{targetSessionId:delivery}};
  const listeners=new Map(),tools=new Map(),rows=new Map([[id,stored]]);
  const calls={checks:[],flushes:[],ownedLookups:[]};
  const ctx={
    profileContext:{dir},
    storageDomain:{get:name=>{assert.equal(name,'schedule');return {table:name=>{
      assert.equal(name,'tasks');return rows;
    }};}},
    schedule:{list:async()=>({items:[]})},
    sessionController:{modelCatalog:async()=>({groups:[{id:route.provider,models:[
      {id:route.model,name:'Alpha',reasoning:{efforts:[{id:'low',name:'Low'},{id:'medium',name:'Medium'}]}},
    ]}]})},
    llm:{resolveCallConfig:async selected=>{calls.checks.push(selected);}},
    agents:{turnBoundaryOf:()=>({lastTurn:0,openTurnStartSeq:null})},
    sessions:{flush:async session=>{calls.flushes.push(session.id);return true;}},
    tools:{register:spec=>{tools.set(spec.name,spec);return ()=>tools.delete(spec.name);}},
    on:(name,value)=>{listeners.set(name,value);return ()=>listeners.delete(name);},
  };
  const register=()=>{
    const plugin=createScheduleOverrides(ctx);
    plugin.registerDeliveryHook();
    plugin.registerTool(async(_schedule,key,actor)=>{
      calls.ownedLookups.push({key,actor});
      if(actor!==owner||![id,task.title].includes(key))return {error:{code:'not_found_in_session'}};
      return matchingTask?matchingTask(task,calls.ownedLookups.length):{task};
    });
    return plugin;
  };
  const plugin=register();
  return {dir,ctx,task,stored,rows,calls,plugin,register,listeners,path:join(dir,'schedule-model-overrides',id+'.json'),
    run:(session,agent=fakeAgent(session),next=async()=>agent)=>listeners.get('schedule/resolve-agent')(session,next),
    clear:async(actor=fakeAgent(owner))=>JSON.parse(await tools.get('schedule_clear_model').execute({identifier:'test'},{agent:actor})),
    edit:async({identifier='test',model='ds',thinking='低'}={},actor=fakeAgent(owner))=>
      JSON.parse(await tools.get('schedule_update_model').execute({identifier,model,thinking},{agent:actor}))};
}

test('update is profile-local and persists; completes fresh reserved route without touching schedule or preset',async t=>{
  const f=await fixture(t);
  const snapshot=structuredClone(f.task);
  assert.deepEqual(await f.edit(),{id,configured:route,appliesTo:'fresh deliveries that have not yet selected their route'});
  assert.deepEqual(f.task,snapshot);
  assert.deepEqual(JSON.parse(await readFile(f.path,'utf8')),{version:1,scheduleId:id,selection:route});
  assert.deepEqual(await f.register().configured(f.task),route);
  const agent=fakeAgent();
  assert.equal(await f.run(delivery,agent),agent);
  assert.deepEqual(agent.selections,[route]);
  assert.deepEqual(f.calls.flushes,[delivery]);
});

test('an unrelated, completed, reused, or new-once session is never selected',async t=>{
  const f=await fixture(t);
  await f.edit();
  assert.deepEqual((await f.run('session-other')).selections,[]);
  f.stored.lastDelivery={targetSessionId:delivery,messageId:'already-ran'};
  delete f.stored.pendingDelivery;
  assert.deepEqual((await f.run(delivery)).selections,[]);
  f.stored.pendingDelivery={targetSessionId:delivery};
  for(const kind of ['session','new_once']){
    f.stored.target.kind=kind;
    assert.deepEqual((await f.run(delivery)).selections,[]);
  }
  assert.deepEqual(f.calls.flushes,[]);
});

test('authorization, freshness and effort validation reject invalid edits without state',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await f.edit({},fakeAgent('session-not-owner')),{code:'not_found_in_session'});
  await assert.rejects(f.edit({},Object.assign(fakeAgent(owner),{options:{subagentDepth:1}})),/root session/);
  assert.equal((await f.edit({thinking:'high'})).code,'unsupported_or_ambiguous_thinking');
  f.task.target.kind='new_once';
  assert.deepEqual(await f.edit(),{code:'requires_fresh_session_target',id});
  await assert.rejects(readFile(f.path),{code:'ENOENT'});
});

test('bad durable selection, removed provider, mismatched activation and persistence failures stop the correlated delivery',async t=>{
  const f=await fixture(t);
  await f.edit();
  await assert.rejects(f.run(delivery,fakeAgent('session-other')),/reservation/);
  f.ctx.llm.resolveCallConfig=async()=>{throw Error('provider unavailable');};
  await assert.rejects(f.run(delivery),/route_unavailable/);
  assert.equal((await f.plugin.state(f.task)).lastSkipped.status,'blocked_before_delivery');
  assert.deepEqual((await f.run('session-other')).selections,[]);
  f.ctx.llm.resolveCallConfig=async()=>{};
  f.ctx.sessions.flush=async()=>false;
  const affected=fakeAgent();
  await assert.rejects(f.run(delivery,affected),/selection_not_persisted/);
  assert.deepEqual(affected.model.current(),affected.before,'restore known original selected route if still pre-turn');
  await writeFile(f.path,'{"version":1,"scheduleId":"wrong"}');
  await assert.rejects(f.run(delivery),/override_unreadable/);
  assert.equal((await f.plugin.state(f.task)).overrideStatus,'unreadable');
  assert.deepEqual((await f.run('session-other')).selections,[]);
});

test('pre-turn next-step briefing is allowed; already-started route is left unchanged and reported',async t=>{
  const f=await fixture(t);
  await f.edit();
  const blank=fakeAgent();
  blank.inbox.nextStep.push({source:{kind:'startup-memory'}});
  assert.deepEqual((await f.run(delivery,blank)).selections,[route]);
  f.ctx.agents.turnBoundaryOf=()=>({lastTurn:1,openTurnStartSeq:37});
  const inProgress=fakeAgent();
  assert.equal(await f.run(delivery,inProgress),inProgress);
  assert.deepEqual(inProgress.model.current(),inProgress.before);
  const status=await f.plugin.state(f.task);
  assert.deepEqual(status.pending,{status:'reserved',targetSessionId:delivery});
  assert.equal(status.lastSkipped.reason,'session_already_started');
  assert.equal(status.lastSkipped.status,'kept_existing_route');
  const recovered=fakeAgent();
  recovered.before=route;
  assert.deepEqual((await f.run(delivery,recovered)).selections,[]);
});


test('failed model validation or failed authoritative task lookup preserves the previous override',async t=>{
  let failure;
  const f=await fixture(t,(task,index)=>{
    if(index===4 && failure==='lookup')throw new Error('schedule view RPC failed');
    if(index===4 && failure==='access')return {error:{code:'not_found_in_session'}};
    if(index===4 && failure==='changed')return {task:{...task,target:{kind:'session',sessionId:owner}}};
    return {task};
  });
  await f.edit();
  const previous=await readFile(f.path,'utf8');
  f.ctx.llm.resolveCallConfig=async()=>{throw new Error('selected model no longer available');};
  await assert.rejects(f.edit({thinking:'medium'}),/no longer available/);
  assert.equal(await readFile(f.path,'utf8'),previous);
  f.ctx.llm.resolveCallConfig=async()=>{};
  for(const scenario of ['lookup','access','changed']){
    failure=scenario;
    f.calls.ownedLookups.length=2;
    if(scenario==='lookup')await assert.rejects(f.edit({thinking:'medium'}),/schedule view RPC failed/);
    else assert.equal((await f.edit({thinking:'medium'})).code,
      scenario==='access'?'not_found_in_session':'schedule_target_changed');
    assert.deepEqual(f.calls.ownedLookups.slice(2).map(x=>x.key),['test',id]);
    assert.equal(await readFile(f.path,'utf8'),previous);
  }
});

test('two deliveries on one task are isolated; a re-edit only affects its next reservation in this profile',async t=>{
  const f=await fixture(t), another=await fixture(t);
  const first=fakeAgent();
  await f.edit();
  await f.run(delivery,first);
  assert.deepEqual(first.selections,[route]);
  const next='session-run-next';
  f.stored.pendingDelivery.targetSessionId=next;
  await f.edit({thinking:'medium',model:'Alpha'});
  assert.deepEqual(await another.plugin.configured(another.task),null);
  assert.deepEqual((await another.run(delivery)).selections,[]);
  const second=await f.run(next);
  assert.deepEqual(first.selections,[route]);
  assert.deepEqual(second.selections,[{...route,reasoningEffort:'medium'}]);
  assert.deepEqual(f.calls.flushes,[delivery,next]);
});


test('native failure propagates untouched and can drive native reserved-session creation',async t=>{
  const f=await fixture(t);
  await f.edit();
  const err=Object.assign(new Error('not found'),{code:'session/not-found'});
  await assert.rejects(f.run(delivery,fakeAgent(),async()=>{throw err;}),e=>e===err);
  assert.equal((await f.plugin.state(f.task)).lastSkipped,null);
});

test('clear requires ownership, reverts future delivery without changing native row, and is idempotent',async t=>{
  const f=await fixture(t);
  await f.edit();
  const before=structuredClone(f.task);
  assert.deepEqual(await f.clear(fakeAgent('foreign')),{code:'not_found_in_session'});
  await assert.rejects(f.clear(Object.assign(fakeAgent(owner),{options:{subagentDepth:1}})),/root session/);
  await writeFile(f.path,'malformed even before provider validation');
  await assert.rejects(f.run(delivery),/override_unreadable/);
  assert.equal((await f.clear()).cleared,true);
  assert.equal((await f.clear()).cleared,false);
  assert.equal((await f.plugin.state(f.task)).overrideStatus,'none');
  assert.deepEqual((await f.run(delivery)).selections,[]);
  assert.deepEqual(f.task,before);
});

test('staging reservation is blocked; fresh title persists across runs and explicit model clear',async t=>{
  const f=await fixture(t);
  const target=structuredClone(f.stored.target);
  f.stored.target.create.agentPreset='dsh-schedule-model/setup/test';
  await assert.rejects(f.run(delivery,fakeAgent(),async()=>assert.fail('staging must not activate')),/not been activated/);
  f.stored.target=target;
  const titles=new Map();
  f.ctx.get=()=>({get:session=>titles.get(session.id),rename:(session,title)=>titles.set(session.id,{title})});
  await f.plugin.prepareFresh(id,route,'Pinned report');
  assert.deepEqual((await f.run(delivery)).selections,[route]);
  assert.equal(titles.get(delivery).title,'Pinned report');
  f.stored.pendingDelivery.targetSessionId='session-two';
  assert.deepEqual((await f.run('session-two')).selections,[route]);
  assert.equal(titles.get('session-two').title,'Pinned report');
  await f.clear();
  f.stored.pendingDelivery.targetSessionId='session-three';
  assert.deepEqual((await f.run('session-three')).selections,[]);
  assert.equal(titles.get('session-three').title,'Pinned report');
});

test('a fresh created policy blocks missing selection and refuses a mismatched started agent',async t=>{
  const f=await fixture(t);
  await f.plugin.prepareFresh(id,route);
  f.ctx.agents.turnBoundaryOf=()=>({lastTurn:1,openTurnStartSeq:null});
  await assert.rejects(f.run(delivery),/session_already_started/);
  assert.equal((await f.plugin.state(f.task)).lastSkipped.status,'blocked_before_delivery');
  await rm(f.path);
  await assert.rejects(f.run(delivery),/override_unreadable/);
  assert.equal((await f.plugin.state(f.task)).overrideStatus,'unreadable');
  await f.clear();
  assert.deepEqual((await f.run(delivery)).selections,[]);
});

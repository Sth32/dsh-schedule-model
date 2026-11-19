import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerScheduleAdmin} from './schedule-admin.js';
import {createScheduleOverrides} from './schedule-override.js';

const a='schedule-a',b='schedule-b',c='schedule-c';
const approved='allowed-once';
const selected={provider:'ds-test',model:'alpha',reasoningEffort:'low'};
const before={provider:'old',model:'beta'};
const titleA='First task';
const managementPreset='allow-native-admin';
const mockTask=(id,title,kind='new')=>({
  id,title,status:'active',updatedAt:'2026-11-19T08:00:00Z',
  target:kind==='new'?{kind,create:{cwd:'/PRIVATE/DIRECTORY',agentPreset:'stock-ptc'}}:{kind,sessionId:'session-private'},
  prompt:'PRIVATE TASK PROMPT',involvedSessionIds:['session-native-old-creator'],
});
function fakeAgent(preset=managementPreset,depth=0) {
  const ctx={get:key=>key==='agentPresets'?{composedPreset:()=>preset}:undefined};
  return {options:{subagentDepth:depth},ctx,session:{id:'session-owner-new',header:{}}};
}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'dsh-admin-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const tasks=new Map([[a,mockTask(a,titleA)],[b,mockTask(b,'Second task')],[c,mockTask(c,'Reused','session')]]);
  const registry=new Map(),activation=new Map();
  const captures={asks:[],nativeReads:0,liveness:true,approval:async()=>approved};
  const raw=new Map();
  const ctx={
    profileContext:{dir},storageDomain:{get:()=>({table:()=>raw})},
    schedule:{async view({id}){captures.nativeReads++;return tasks.get(id);},
      async list({offset,limit}){captures.nativeReads++;return {total:tasks.size,items:[...tasks.values()].slice(offset,offset+limit)};}},
    typertGateway:{hasLiveClient:()=>captures.liveness},
    sessionController:{modelCatalog:async()=>({groups:[{id:'ds-test',models:[{id:'alpha',name:'Alpha',reasoning:{efforts:[{id:'low',name:'Low'}]}}]}]}),
      events:async()=>({hasMore:false,records:[{event:{type:'model/selection',data:{provider:'test',model:'recorded'}}}]})},
    llm:{resolveCallConfig:async()=>{}},
    approval:{request:async req=>{captures.asks.push(req);return captures.approval(req);}},
    tools:{get:name=>captures.stock===false?undefined:{name},register(tool,params){
      registry.set(tool.name,tool);activation.set(tool.name,params.when);return ()=>registry.delete(tool.name);
    }},
  };
  const overrides=createScheduleOverrides(ctx);
  const dispose=registerScheduleAdmin(ctx,overrides,{managementPreset,approvalMs:25});
  t.after(dispose);
  const exec=(agent=fakeAgent())=>({agent,callId:'owner-tool-call',signal:new AbortController().signal});
  return {ctx,tasks,captures,overrides,activation,registry,
    read:(args={},details=exec())=>registry.get('schedule_admin_model_list').execute(args,details).then(JSON.parse),
    update:(ids,details=exec())=>registry.get('schedule_admin_model_batch_update')
      .execute({ids,model:'Alpha',thinking:'低'},details).then(JSON.parse),
    clear:(ids,details=exec())=>registry.get('schedule_admin_model_batch_update')
      .execute({ids,action:'clear'},details).then(JSON.parse),exec};
}
test('inventory only after actual owner approval; no cross-session prompt or path leakage',async t=>{
  const f=await fixture(t);
  f.captures.liveness=false;
  assert.equal((await f.read()).code,'owner_ui_approval_unavailable');
  assert.equal(f.captures.asks.length,0);
  assert.equal(f.captures.nativeReads,0);
  f.captures.liveness=true;
  f.captures.approval=async()=>'rejected';
  assert.equal((await f.read()).code,'owner_ui_approval_not_granted');
  assert.equal(f.captures.nativeReads,0);
  f.captures.approval=async()=>approved;
  const page=await f.read();
  assert.deepEqual(page.items.map(row=>row.id),[a,b,c]);
  assert.equal(page.items[2].configured.model,'recorded');
  assert.equal(page.items[2].configurable,false);
  assert.doesNotMatch(JSON.stringify(page),/PRIVATE|session-private|involvedSessionIds/);
  assert.equal(f.captures.asks.at(-1).callId,'owner-tool-call');
});
test('wrong preset, stock schedule restriction, delegation and absent actual call fail closed',async t=>{
  const f=await fixture(t);
  for(const agent of [fakeAgent('not-admin'),fakeAgent(managementPreset,1)]) {
    assert.equal(f.activation.get('schedule_admin_model_list')({agent}),false);
    assert.equal((await f.read({},f.exec(agent))).code,'owner_ui_approval_unavailable');
  }
  assert.equal((await f.read({},{...f.exec(),callId:undefined})).code,'owner_ui_approval_unavailable');
  f.captures.stock=false;
  assert.equal((await f.update([a])).code,'owner_ui_approval_unavailable');
  assert.equal(f.captures.asks.length,0);
  assert.equal(f.captures.nativeReads,0);
});
test('all exact fresh IDs preflight, and native refusal produces no writes or unauthorized detail',async t=>{
  const f=await fixture(t);
  assert.equal((await f.update([a,a])).code,'invalid_exact_task_ids');
  assert.equal((await f.update([a,'First task'])).code,'invalid_exact_task_ids');
  assert.equal((await f.update([a,c])).code,'batch_preflight_rejected_no_changes');
  assert.equal(f.captures.asks.length,0);
  f.captures.approval=async()=>'unavailable';
  assert.equal((await f.update([a,b])).code,'owner_ui_approval_not_granted');
  assert.equal(await f.overrides.configured(f.tasks.get(a)),null);
});
test('one confirmation shows canonical requested route, all exact IDs and existing routes; task edits during approval are stale',async t=>{
  const f=await fixture(t);
  await f.overrides.commitConfirmed(a,before,f.exec().signal,async()=>true,null);
  const originals=structuredClone([...f.tasks.values()]);
  f.captures.approval=async req=>{
    assert.match(req.displayReason.en,/schedule-a.*First task.*old.*beta/);
    assert.match(req.displayReason.en,/schedule-b.*Second task.*native preset/);
    assert.match(req.displayReason.en,/ds-test.*alpha.*low/);
    assert.doesNotMatch(req.displayReason.en,/PRIVATE/);
    f.tasks.get(b).updatedAt='2026-11-19T09:00:00Z';
    return approved;
  };
  const result=await f.update([a,b]);
  assert.equal(result.status,'partial');
  assert.deepEqual(result.results,[{id:a,status:'changed',configured:selected},{id:b,status:'not_changed',code:'stale_task'}]);
  assert.deepEqual(await f.overrides.configured(f.tasks.get(a)),selected);
  assert.deepEqual(f.tasks.get(a),originals[0]);
  assert.equal(await f.overrides.configured(f.tasks.get(b)),null);
  assert.equal(f.captures.asks.length,1);
});
test('mid-confirmation sidecar change or late approval cannot overwrite',async t=>{
  const f=await fixture(t);
  f.captures.approval=async()=>{
    await f.overrides.commitConfirmed(a,before,f.exec().signal,async()=>true,null);
    return approved;
  };
  assert.deepEqual((await f.update([a])).results,[{id:a,status:'not_changed',code:'stale_override'}]);
  f.captures.approval=async req=>{
    await new Promise(resolve=>{
      const limit=setTimeout(resolve,50);
      req.signal.addEventListener('abort',()=>{clearTimeout(limit);resolve();},{once:true});
    });
    return approved;
  };
  assert.equal((await f.update([b])).code,'owner_ui_approval_not_granted');
  assert.equal(await f.overrides.configured(f.tasks.get(b)),null);
});

test('owner-approved clear restores only approved fresh overrides and is idempotent',async t=>{
  const f=await fixture(t);
  await f.overrides.commitConfirmed(a,before,f.exec().signal,async()=>true,null);
  await f.overrides.commitConfirmed(b,selected,f.exec().signal,async()=>true,null);
  f.captures.approval=async()=> 'rejected';
  assert.equal((await f.clear([a])).code,'owner_ui_approval_not_granted');
  assert.deepEqual(await f.overrides.configured(f.tasks.get(a)),before);
  f.captures.approval=async req=>{
    assert.match(req.displayReason.en,/Restore native preset\/default/);
    assert.match(req.displayReason.en,/schedule-a/);
    assert.doesNotMatch(req.displayReason.en,/schedule-b/);
    return approved;
  };
  assert.deepEqual(await f.clear([a]),{status:'complete',changed:1,
    results:[{id:a,status:'changed',configured:null}]});
  assert.deepEqual(await f.clear([a]),{status:'complete',changed:0,
    results:[{id:a,status:'unchanged',configured:null}]});
  assert.deepEqual(await f.overrides.configured(f.tasks.get(b)),selected);
});

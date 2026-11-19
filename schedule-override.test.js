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
  let hook,tool;
  const calls={checks:[],flushes:[],ownedLookups:[]};
  const ctx={
    profileContext:{dir},
    storageDomain:{get:name=>{assert.equal(name,'schedule');return {table:name=>{
      assert.equal(name,'tasks');return new Map([[id,stored]]);
    }};}},
    schedule:{},
    sessionController:{modelCatalog:async()=>({groups:[{id:route.provider,models:[
      {id:route.model,name:'Alpha',reasoning:{efforts:[{id:'low',name:'Low'},{id:'medium',name:'Medium'}]}},
    ]}]})},
    llm:{resolveCallConfig:async selected=>{calls.checks.push(selected);}},
    agents:{turnBoundaryOf:()=>({lastTurn:0,openTurnStartSeq:null})},
    sessions:{flush:async session=>{calls.flushes.push(session.id);return true;}},
    tools:{register:spec=>{tool=spec;return ()=>{};}},
    on:(name,value)=>{assert.equal(name,'schedule/resolve-agent');hook=value;return ()=>{};},
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
  return {dir,ctx,task,stored,calls,plugin,register,path:join(dir,'schedule-model-overrides',id+'.json'),
    run:(session,agent=fakeAgent(session))=>hook(session,async()=>agent),
    edit:async({identifier='test',model='ds',thinking='低'}={},actor=fakeAgent(owner))=>
      JSON.parse(await tool.execute({identifier,model,thinking},{agent:actor}))};
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
  await assert.rejects(f.run(delivery),/provider unavailable/);
  assert.deepEqual((await f.run('session-other')).selections,[]);
  f.ctx.llm.resolveCallConfig=async()=>{};
  f.ctx.sessions.flush=async()=>false;
  await assert.rejects(f.run(delivery),/persist/);
  await writeFile(f.path,'{"version":1,"scheduleId":"wrong"}');
  await assert.rejects(f.run(delivery),/override state/);
  assert.deepEqual((await f.run('session-other')).selections,[]);
});

test('still-blank agent pins an equal fallback while started attempt retains only an exact selection',async t=>{
  const f=await fixture(t);
  await f.edit();
  const blank=fakeAgent();
  blank.before=route;
  assert.deepEqual((await f.run(delivery,blank)).selections,[route]);
  f.ctx.agents.turnBoundaryOf=()=>({lastTurn:1,openTurnStartSeq:37});
  await assert.rejects(f.run(delivery),/already|started/);
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

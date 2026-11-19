import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareReceivingSessionModel} from './receiving-session-model.js';

const a='schedule-first', b='schedule-second', c='schedule-historical';
const receiving='session-receiving', manager='session-management';
const old={provider:'local',model:'legacy',reasoningEffort:'low'};
const next={provider:'different',model:'alpha',reasoningEffort:'high'};
const signal=()=>new AbortController().signal;

function fixture(){
  const events=[];
  const task=(id,title,taskOptions={})=>({id,title,updatedAt:'2026-11-19T05:00:00Z',
    target:{kind:'session',sessionId:receiving},status:'active',scheduledAt:'2099-01-01T00:00:00Z',
    prompt:'PRIVATE-PROMPT',...taskOptions});
  let current=old;
  const actor={options:{},session:{id:manager,header:{}}};
  const agent={options:{},session:{id:receiving,header:{},get seq(){return events.length;},
    eventAt(offset){return events[offset];}},status:'idle',inbox:{nextStep:[],nextTurn:[]}};
  const state={events,taskRows:[task(a,'First'),task(b,'Second',{status:'paused'}),task(c,'Historical',{
    target:{kind:'new',create:{agentPreset:'native'}},lastDelivery:{targetSessionId:receiving},
  })],branch:agent,preset:'standard',archived:[],turn:{openTurnStartSeq:null,lastTurn:1},
  maintenance:true,flush:true,maintained:0,activated:0,selected:0};
  agent.ctx={get:()=>({composedPreset:()=>state.preset,presetForSession:()=>state.preset})};
  agent.model={current:()=>current,select(value){
    current=structuredClone(value);events.push({type:'model/selection',data:current});state.selected++;
  }};
  agent.runMaintenance=fn=>{
    if(!state.maintenance)throw Error('active work');
    state.maintained++;
    return fn(signal());
  };
  const ctx={
    schedule:{catalog:async()=>state.taskRows},
    agents:{get:value=>value===receiving?state.branch:undefined,turnBoundaryOf:()=>state.turn},
    sessions:{flush:async()=>state.flush},
    sessionController:{resolveAgent(){state.activated++;throw Error('must never activate');}},
    get:key=>key==='workspaceRegistry'?{archivedSessionIds:state.archived}:
      key==='sessionTitle'?{get:()=>({title:'Receiving chat'})}:undefined,
    llm:{resolveCallConfig:async config=>config},
  };
  return {ctx,agent,actor,state,prepare:(id=a,extra={})=>prepareReceivingSessionModel(ctx,{
    id,selection:next,actor,signal:signal(),...extra,
  }), commit:(operation,scope=true,abort=signal())=>operation.commit({signal:abort,verifyScope:()=>scope})};
}
test('exhaustive preview lists receiving interactive chat, all bound tasks and distinct historical associations',async()=>{
  const f=fixture();
  const result=await f.prepare();
  assert.equal(result.plan.sessionId,receiving);
  assert.equal(result.plan.sessionTitle,'Receiving chat');
  assert.equal(result.plan.interactiveChatAlsoChanges,true);
  assert.deepEqual(result.plan.affectedTasks.map(row=>row.id),[a,b]);
  assert.deepEqual(result.plan.otherAssociatedTasks.map(row=>row.id),[c]);
  assert.doesNotMatch(JSON.stringify(result.plan),/PRIVATE-PROMPT/);
  assert.deepEqual(result.plan.from,old);
  assert.deepEqual(result.plan.to,next);
  assert.equal(f.state.maintained,0);
  assert.equal(f.state.selected,0);
  assert.equal(f.state.activated,0);
});
test('approved idle whole-session change writes one native event and preserves native tasks',async()=>{
  const f=fixture();
  const operation=await f.prepare();
  const baseline=structuredClone(f.state.taskRows);
  operation.plan.sessionId='session-tampered'; // public preview is detached
  operation.plan.affectedTasks.pop();
  assert.deepEqual(await f.commit(operation),{status:'changed',sessionId:receiving,configured:next,
    affectedTaskIds:[a,b],interactiveChatAlsoChanges:true});
  assert.deepEqual(f.state.taskRows,baseline);
  assert.deepEqual(f.state.events,[{type:'model/selection',data:next}]);
  assert.equal(f.state.maintained,1);
  assert.equal(f.state.activated,0);
  assert.equal((await f.commit(operation)).code,'receiving_session_plan_consumed');
});
test('declines cold, self, archived, pending, unsupported pin and already queued before opening a plan',async()=>{
  const f=fixture();
  f.state.branch=undefined;
  assert.equal((await f.prepare()).code,'open_receiving_session_first');
  f.state.branch=f.agent;
  f.actor.session.id=receiving;
  assert.equal((await f.prepare()).code,'cannot_change_management_session');
  f.actor.session.id=manager;
  f.state.archived.push(receiving);
  assert.equal((await f.prepare()).code,'receiving_session_archived');
  f.state.archived.pop();
  assert.equal((await f.prepare(a,{routes:new Map([['standard',old]])})).code,'receiving_session_route_persistence_unsupported');
  f.state.preset='internal-company-custom';
  assert.equal((await f.prepare()).code,'receiving_session_route_persistence_unsupported');
  f.state.preset='standard';
  f.state.taskRows[0].executionActive=true;
  assert.equal((await f.prepare()).code,'receiving_session_scheduled_work_pending');
  delete f.state.taskRows[0].executionActive;
  f.agent.inbox.nextTurn.push({});
  assert.equal((await f.prepare()).code,'receiving_session_busy');
  assert.equal(f.state.selected,0);
  assert.equal(f.state.activated,0);
});
test('not authorized, stale new association, hidden native activity, and arriving queue cannot write',async()=>{
  const denied=fixture(), stale=fixture(), busy=fixture(), queued=fixture();
  assert.equal((await denied.commit(await denied.prepare(),false)).code,'receiving_session_plan_not_authorized');
  const oldPlan=await stale.prepare();
  stale.state.taskRows[2].target={kind:'session',sessionId:receiving};
  assert.equal((await stale.commit(oldPlan)).code,'receiving_session_plan_stale');
  const idlePlan=await busy.prepare();
  busy.state.maintenance=false;
  assert.equal((await busy.commit(idlePlan)).code,'receiving_session_busy');
  const queuePlan=await queued.prepare();
  queued.ctx.llm.resolveCallConfig=async()=>{queued.agent.inbox.nextStep.push({});};
  assert.equal((await queued.commit(queuePlan)).code,'receiving_session_plan_stale');
  for(const f of [denied,stale,busy,queued])assert.equal(f.state.selected,0);
});
test('persistence refusal is unverified, not false success or a rollback over someone else',async()=>{
  const f=fixture();
  f.state.flush=false;
  assert.deepEqual(await f.commit(await f.prepare()),{status:'unverified',
    code:'receiving_session_persistence_unverified',sessionId:receiving});
  const race=fixture();
  race.ctx.sessions.flush=async()=>{race.agent.model.select({provider:'other',model:'chosen'});return true;};
  assert.equal((await race.commit(await race.prepare())).status,'unverified');
  assert.deepEqual(race.agent.model.current(),{provider:'other',model:'chosen'});
});

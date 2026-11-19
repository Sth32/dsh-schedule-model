import { isDeepStrictEqual } from 'node:util';
import { validateNaturalRoute } from './natural.js';
import { delegationDepthOf } from './tool.js';

// Only the Web/desktop ordinary session composition with a shipped preset was
// audited here. Arbitrary profile-installed hooks can impose another route on
// remount, so custom presets or known local pins are not supported.
const auditedPresets=new Set(['standard','ptc']);
const maxImpact=25;
const unavailable=code=>({code});
const validId=id=>typeof id==='string'&&/^schedule-[A-Za-z0-9_-]{1,100}$/.test(id);
const short=value=>typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,120):null;
const exactRoute=(a,b)=>!!a&&!!b&&a.provider===b.provider&&a.model===b.model&&a.reasoningEffort===b.reasoningEffort;
const safeRoute=value=>!!value&&[value.provider,value.model,...(value.reasoningEffort===undefined?[]:[value.reasoningEffort])]
  .every(field=>typeof field==='string'&&!!field&&field.length<=160&&!/[\p{Cc}\p{Cf}]/u.test(field));
const copyRoute=value=>({provider:value.provider,model:value.model,
  ...(value.reasoningEffort===undefined?{}:{reasoningEffort:value.reasoningEffort})});
const isReused=row=>row?.target?.kind==='session';
const currentDestination=(row,id)=>
  (row?.target?.kind==='session'||row?.target?.kind==='new_once')&&row.target.sessionId===id;
const inAnyHistory=(row,id)=>row.involvedSessionIds?.includes(id)||row.lastDelivery?.targetSessionId===id;
const viewRow=(row,id)=>({id:row.id,title:short(row.title),status:row.status,
  targetKind:row.target.kind,affected:currentDestination(row,id),scheduledAt:row.scheduledAt??null,
  updatedAt:row.updatedAt??null,
});
function ready(ctx,agent){
  const boundary=ctx.agents.turnBoundaryOf(agent.session);
  return agent.status==='idle'&&boundary.openTurnStartSeq===null&&agent.inbox.nextTurn.length===0&&agent.inbox.nextStep.length===0;
}
function sameImpact(a,b){
  return a.sessionId===b.sessionId&&a.sessionTitle===b.sessionTitle&&
    a.preset===b.preset&&a.sessionSeq===b.sessionSeq&&exactRoute(a.from,b.from)&&
    isDeepStrictEqual(a.affectedTasks,b.affectedTasks)&&isDeepStrictEqual(a.otherAssociatedTasks,b.otherAssociatedTasks);
}

/**
 * Prepare one host-scoped, passive, single-use whole-session change plan.
 * The handler MUST show the actual plan to the owner via native browser
 * approval, including both affected task IDs and the interactive conversation.
 * No caller-supplied Session ID or approval token is accepted by the engine.
 */
export async function prepareReceivingSessionModel(ctx,{id,selection,actor,routes,signal}){
  if(!validId(id)||!actor||delegationDepthOf(actor)>0||!safeRoute(selection))return unavailable('invalid_session_change');
  const desired=copyRoute(selection);
  const invalid=await validateNaturalRoute(ctx.llm,desired,signal);
  if(invalid)return invalid;
  const knownPins=routes??new Map();

  async function inspect(){
    signal.throwIfAborted();
    const entries=await ctx.schedule.catalog();
    signal.throwIfAborted();
    if(!Array.isArray(entries))return unavailable('schedule_catalog_unavailable');
    const task=entries.find(item=>item.id===id);
    if(!task)return unavailable('schedule_not_found');
    if(!isReused(task))return unavailable('requires_bound_reused_session');
    const sessionId=task.target.sessionId;
    if(typeof sessionId!=='string'||!sessionId||sessionId===actor.session.id)return unavailable('cannot_change_management_session');
    const registry=ctx.get('workspaceRegistry');
    if(!registry||!Array.isArray(registry.archivedSessionIds))return unavailable('session_archive_state_unavailable');
    if(registry.archivedSessionIds.includes(sessionId))return unavailable('receiving_session_archived');
    // get() is visibility only. Do not call controller.resolveAgent (resumes
    // cold work), wake queued delivery, leave a job waiting, or start a turn.
    const agent=ctx.agents.get(sessionId);
    if(!agent||agent.session.id!==sessionId||typeof agent.runMaintenance!=='function')
      return unavailable('open_receiving_session_first');
    if(delegationDepthOf(agent)>0||!ready(ctx,agent))return unavailable('receiving_session_busy');
    const presetService=agent.ctx?.get('agentPresets');
    const preset=presetService?.composedPreset(agent.ctx);
    if(!auditedPresets.has(preset)||knownPins.has(preset)||presetService.presetForSession(agent.session)!==preset)
      return unavailable('receiving_session_route_persistence_unsupported');
    const from=agent.model.current();
    if(!safeRoute(from)||!Number.isSafeInteger(agent.session.seq))return unavailable('receiving_session_state_unavailable');
    const relevant=entries.filter(row=>currentDestination(row,sessionId)||inAnyHistory(row,sessionId));
    if(relevant.length>maxImpact||relevant.some(item=>!validId(item.id)||!item.target)||
        new Set(relevant.map(item=>item.id)).size!==relevant.length)
      return unavailable('receiving_session_impact_unavailable');
    // Reused due work can be batched natively. Avoid intercepting a delivery
    // already held, in flight, or eligible to enter the inbox immediately.
    const bound=relevant.filter(item=>currentDestination(item,sessionId));
    if(bound.some(item=>item.executionActive||
        (item.status==='active'&&(!Number.isFinite(Date.parse(item.scheduledAt))||Date.parse(item.scheduledAt)<=Date.now()))))
      return unavailable('receiving_session_scheduled_work_pending');
    const compare=(a,b)=>a.id.localeCompare(b.id);
    const sessionTitle=short(ctx.get('sessionTitle')?.get(agent.session)?.title);
    const plan={
      taskId:id,sessionId,sessionTitle,preset,sessionSeq:agent.session.seq,
      from:copyRoute(from),to:copyRoute(desired),
      affectedTasks:bound.map(item=>viewRow(item,sessionId)).sort(compare),
      otherAssociatedTasks:relevant.filter(item=>!currentDestination(item,sessionId)).map(item=>viewRow(item,sessionId)).sort(compare),
      interactiveChatAlsoChanges:true,
    };
    return {agent,plan};
  }

  const prepared=await inspect();
  if(!prepared.plan)return prepared;
  const plan=prepared.plan;
  let used=false;
  return {
    plan:structuredClone(plan),
    async commit({signal:approvalSignal,verifyScope}){
      if(used)return unavailable('receiving_session_plan_consumed');
      used=true;
      const stop=AbortSignal.any([signal,approvalSignal]);
      if(stop.aborted||verifyScope()!==true)return unavailable('receiving_session_plan_not_authorized');
      const agent=prepared.agent;
      if(ctx.agents.get(plan.sessionId)!==agent||!ready(ctx,agent))return unavailable('receiving_session_plan_stale');
      let claimed=false;
      let attempted=false;
      try{
        return await agent.runMaintenance(async maintenanceSignal=>{
          claimed=true;
          const lifetime=AbortSignal.any([stop,maintenanceSignal]);
          lifetime.throwIfAborted();
          const invalid=await validateNaturalRoute(ctx.llm,desired,lifetime);
          if(invalid)return invalid;
          const current=await inspect();
          if(!current.plan||current.agent!==agent||!sameImpact(prepared.plan,current.plan))
            return unavailable('receiving_session_plan_stale');
          // Last checks and the selection event are synchronous while native
          // maintenance owns the driver; no message is started by this tool.
          if(lifetime.aborted||verifyScope()!==true||ctx.agents.get(plan.sessionId)!==agent||
              !ready(ctx,agent)||agent.session.seq!==current.plan.sessionSeq||
              !exactRoute(agent.model.current(),current.plan.from))
            return unavailable('receiving_session_plan_stale');
          if(exactRoute(current.plan.from,desired))return {status:'unchanged',sessionId:plan.sessionId,configured:copyRoute(desired)};
          attempted=true;
          agent.model.select(desired);
          const selectedSeq=agent.session.seq;
          const persisted=await ctx.sessions.flush(agent.session);
          if(!persisted||ctx.agents.get(plan.sessionId)!==agent||!exactRoute(agent.model.current(),desired))
            return {status:'unverified',code:'receiving_session_persistence_unverified',sessionId:plan.sessionId};
          const event=agent.session.eventAt(selectedSeq-1);
          if(event?.type!=='model/selection'||!exactRoute(event.data,desired))
            return {status:'unverified',code:'receiving_session_selection_event_unverified',sessionId:plan.sessionId};
          // A provider/route update could still be made by another user
          // independently after this operation. This is not a per-task pin.
          return {status:'changed',sessionId:plan.sessionId,configured:copyRoute(desired),
            affectedTaskIds:prepared.plan.affectedTasks.map(row=>row.id),interactiveChatAlsoChanges:true};
        });
      }catch{
        return attempted?{status:'unverified',code:'receiving_session_persistence_unverified',sessionId:plan.sessionId}:
          unavailable(claimed?'receiving_session_plan_stale':'receiving_session_busy');
      }
    },
  };
}

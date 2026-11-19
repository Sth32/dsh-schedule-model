// Retarget one existing reused task, leaving its original Session untouched.
// No task edit or Session creation occurs in preflight.
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateNaturalRoute } from './natural.js';

const taskId=/^schedule-[A-Za-z0-9_-]{1,100}$/;
const knownUnpinnedPresets=new Set(['standard','ptc']);
const supportedTiming=new Set(['at','every','daily','weekly','cron','rrule']);
const drafts=new WeakMap();
const locks=new Set();
const no=code=>({ok:false,code});
const display=value=>String(value).replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,120);
const exact=(a,b)=>a?.provider===b?.provider&&a?.model===b?.model&&
  (a?.reasoningEffort??null)===(b?.reasoningEffort??null);
const label=v=>typeof v==='string'&&v.length>0&&v.length<=160&&v.trim()===v&&!/[\p{Cc}\p{Cf}]/u.test(v);
const snapshot=task=>{
  const {target,updatedAt,involvedSessionIds,executionActive,deliveryFloorEndsAt,...stable}=task;
  return structuredClone(stable);
};
const effectiveSignal=signal=>signal??new AbortController().signal;

async function lookup(ctx,id){
  const task=await ctx.schedule.view({id});
  return task?.id===id&&task.target?.kind==='session'&&typeof task.target.sessionId==='string'
    ?task:null;
}

async function source(ctx,sessionId,signal){
  const registry=ctx.get?.('workspaceRegistry')??ctx.workspaceRegistry;
  if(!registry||registry.archivedSessionIds.includes(sessionId))return no('source_workspace_unavailable');
  const saved=await ctx.sessionPersistence.stat(sessionId,{signal});
  if(!saved||saved.header.id!==sessionId||saved.header.origin==='subagent'||(saved.header.delegationDepth??0)>0)
    return no('source_session_unavailable');
  if(typeof saved.header.cwd!=='string'||!isAbsolute(saved.header.cwd))return no('source_directory_unavailable');
  let cwd;
  try{
    cwd=await realpath(saved.header.cwd);
    if(!(await stat(cwd)).isDirectory())return no('source_directory_unavailable');
  }catch{return no('source_directory_unavailable');}
  signal.throwIfAborted();
  const matches=registry.list().filter(workspace=>workspace.sessionIds.includes(sessionId));
  if(matches.length>1||(matches[0]&&matches[0].path!==cwd))return no('source_workspace_unavailable');
  const projected=await ctx.sessionController.projections({sessionId},signal);
  if(projected?.kind!=='sequenced'||!Object.hasOwn(projected.values??{},'agentPreset'))
    return no('source_preset_unverified');
  const preset=projected.values.agentPreset??ctx.agentPresets.defaultId;
  if(!label(preset))return no('source_preset_unverified');
  const workspace=matches[0];
  const workspaceTitle=workspace&&typeof workspace.title==='string'&&workspace.title!==workspace.path
    ?display(workspace.title):null;
  return {ok:true,cwd,workspaceId:workspace?.id??null,workspaceTitle,preset};
}

function preservePresetRoute(preset,route,routes){
  const pin=routes.get(preset);
  if(pin)return exact(pin,route)?null:'source_preset_pins_different_route';
  return knownUnpinnedPresets.has(preset)?null:'source_preset_route_not_audited';
}

async function validate(ctx,route,signal){
  try{
    const blocked=await validateNaturalRoute(ctx.llm,route,signal);
    return blocked?.code??null;
  }catch(error){
    signal.throwIfAborted();
    return 'route_unavailable';
  }
}

/**
 * Prepare a same-Host target-only change. The returned WeakMap-bound plan is
 * opaque and process-local; the coordinator must use native owner approval
 * before calling applyDedicated. Configured route pins are supplied by caller.
 */
export async function planDedicated(ctx,task,choice,signal,{routes=new Map()}={}){
  signal=effectiveSignal(signal);
  if(typeof task?.id!=='string'||!taskId.test(task.id)||task.target?.kind!=='session')return no('requires_reused_session');
  if(!label(choice?.provider)||!label(choice?.model)||
      (choice.reasoningEffort!==undefined&&!label(choice.reasoningEffort)))return no('invalid_route');
  const route=Object.freeze({provider:choice.provider,model:choice.model,
    ...(choice.reasoningEffort===undefined?{}:{reasoningEffort:choice.reasoningEffort})});
  try{
    signal.throwIfAborted();
    const current=await lookup(ctx,task.id);
    if(!current||!isDeepStrictEqual(current.target,task.target)||
        (current.updatedAt??null)!==(task.updatedAt??null))return no('stale_task');
    if(current.executionActive)return no('task_delivery_active');
    if(!supportedTiming.has(current.kind)||typeof current.scheduledAt!=='string'||
        !Number.isFinite(Date.parse(current.scheduledAt)))return no('timing_not_preservable');
    const location=await source(ctx,current.target.sessionId,signal);
    if(!location.ok)return location;
    const presetProblem=preservePresetRoute(location.preset,route,routes);
    if(presetProblem)return no(presetProblem);
    const routeProblem=await validate(ctx,route,signal);
    if(routeProblem)return no(routeProblem);
    const plan=Object.freeze({});
    drafts.set(plan,{ctx,id:current.id,oldSessionId:current.target.sessionId,updatedAt:current.updatedAt??null,
      facts:snapshot(current),location,route,routes});
    return {ok:true,plan,impact:{
      taskId:current.id,title:display(current.title),oldSessionId:current.target.sessionId,
      workspaceId:location.workspaceId,workspaceTitle:location.workspaceTitle,preset:location.preset,scheduledAt:current.scheduledAt,status:current.status,
      route,creates:'one_dedicated_reused_session',keeps:'schedule_identity_timing_history_and_old_session',
    }};
  }catch{
    if(signal.aborted)return no('cancelled');
    return no('preflight_unavailable');
  }
}

function blank(ctx,agent,sessionId){
  if(!(agent?.session?.id===sessionId)||agent.status!=='idle'||!agent.inbox)return false;
  const boundary=ctx.agents.turnBoundaryOf(agent.session);
  return boundary.lastTurn===0&&boundary.openTurnStartSeq===null&&agent.inbox.nextTurn.length===0&&
    agent.inbox.nextStep.every(message=>message?.source?.kind!=='user'&&message?.source?.kind!=='schedule');
}

export async function applyDedicated(ctx,plan,signal,{verifyScope=()=>true}={}){
  signal=effectiveSignal(signal);
  const draft=drafts.get(plan);
  if(!draft||draft.ctx!==ctx)return no('invalid_plan');
  drafts.delete(plan);
  if(locks.has(draft.id))return no('task_change_in_progress');
  locks.add(draft.id);
  const {id,oldSessionId,updatedAt,facts,location,route,routes}=draft;
  const checkTask=async()=>{
    const task=await lookup(ctx,id);
    return !!task&&task.target.sessionId===oldSessionId&&(task.updatedAt??null)===updatedAt&&
      !task.executionActive&&isDeepStrictEqual(snapshot(task),facts);
  };
  let candidateId,created=false,editStarted=false;
  const unbound=code=>({ok:false,code,...(created?{unattachedDraft:candidateId}:{})});
  async function uncertainty(code){
    let observedTarget='unavailable';
    try{
      const current=await ctx.schedule.view({id});
      if(current?.id===id)observedTarget=current.target?.sessionId===candidateId?'candidate':
        current.target?.sessionId===oldSessionId?'original':'other';
    }catch{}
    return {ok:false,code,taskId:id,possibleTarget:candidateId,observedTarget};
  }
  try{
    signal.throwIfAborted();
    if(!await checkTask())return no('stale_or_active_task');
    if(!isDeepStrictEqual(await source(ctx,oldSessionId,signal),location))return no('source_location_changed');
    const presetProblem=preservePresetRoute(location.preset,route,routes);
    if(presetProblem)return no(presetProblem);
    const problem=await validate(ctx,route,signal);
    if(problem)return no(problem);
    signal.throwIfAborted();
    if(!await checkTask())return no('stale_or_active_task');

    if(!await verifyScope())return no('management_scope_changed');
    signal.throwIfAborted();
    candidateId='session-'+randomUUID();
    const createdResult=await ctx.sessionController.create({sessionId:candidateId,agentPreset:location.preset,
      ...(location.workspaceId===null?{cwd:location.cwd}:{workspaceId:location.workspaceId})});
    created=true;
    if(createdResult.sessionId!==candidateId){
      candidateId=createdResult.sessionId;
      return unbound('fresh_identity_not_retained');
    }
    const {agent}=await ctx.sessionController.resolveAgent(candidateId);
    if(typeof agent.runMaintenance!=='function')return unbound('new_session_maintenance_unavailable');
    return await agent.runMaintenance(async maintenanceSignal=>{
      const combined=AbortSignal.any([signal,maintenanceSignal]);
      if(!blank(ctx,agent,candidateId))return unbound('new_session_not_blank');
      const actual=await source(ctx,candidateId,combined);
      if(!isDeepStrictEqual(actual,location))return unbound('new_session_location_unverified');
      if(!blank(ctx,agent,candidateId))return unbound('new_session_not_blank');
      combined.throwIfAborted();
      agent.model.select(route);
      if(!await ctx.sessions.flush(agent.session)||!exact(agent.model.current(),route))
        return unbound('new_session_route_not_persisted');
      const projection=await ctx.sessionController.projections({sessionId:candidateId},combined);
      if(projection?.kind!=='sequenced'||!exact(projection.values?.modelSelection?.next,route))
        return unbound('new_session_route_unverified');
      if(!isDeepStrictEqual(await source(ctx,oldSessionId,combined),location))
        return unbound('source_location_changed');
      if(!await checkTask())return unbound('stale_or_active_task');
      if(!blank(ctx,agent,candidateId)||!exact(agent.model.current(),route))
        return unbound('new_session_not_blank');
      combined.throwIfAborted();
      if(!await verifyScope())return unbound('management_scope_changed');
      if(!blank(ctx,agent,candidateId)||!exact(agent.model.current(),route))
        return unbound('new_session_not_blank');
      combined.throwIfAborted();
      editStarted=true;
      const result=await ctx.schedule.edit({
        id,action:'update',expectedUpdatedAt:updatedAt,patch:{target:{kind:'session',sessionId:candidateId}},
      },undefined,combined);
      if(result?.code==='schedule_conflict'||result?.code==='schedule_not_found')
        return unbound('native_'+result.code);
      if(result?.id!==id||result.target?.sessionId!==candidateId)
        return await uncertainty('retarget_outcome_unknown');
      if(!isDeepStrictEqual(snapshot(result),facts))
        return await uncertainty('retarget_invariant_unverified');
      return {ok:true,status:'retargeted',taskId:id,oldSessionId,sessionId:candidateId,route};
    });
  }catch{
    if(editStarted)return await uncertainty('retarget_outcome_unknown');
    if(candidateId&&!created){
      // Create can fail after native Workspace attachment begins. Look only
      // for the candidate just minted by this operation; never archive/delete.
      try{created=(await ctx.sessionPersistence.stat(candidateId))?.header?.id===candidateId;}catch{}
    }
    return unbound(signal.aborted?'cancelled':'dedicated_setup_failed');
  }finally{locks.delete(id);}
}

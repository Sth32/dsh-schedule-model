import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { apply as installPin, selection } from './index.js';
import { inspectLatest, configuredSessionModel } from './observe.js';
import { resolveNatural, naturalTiming, validateNaturalRoute } from './natural.js';
import { defineTool, delegationDepthOf } from './tool.js';
import { createScheduleOverrides } from './schedule-override.js';
import { registerScheduleAdmin } from './schedule-admin.js';
import { registerReuseAdmin } from './reuse-admin.js';
import { prepareReceivingSessionModel } from './receiving-session-model.js';
import { planDedicated, applyDedicated } from './dedicated-session.js';

export const name = 'schedule-model-create';
export const inject = ['schedule', 'tools', 'agentPresets', 'sessionController', 'llm', 'sessions', 'systemPrompt'];
const str = description => ({type:'string', required:true, description});

export function apply(ctx, config) {
  const routes = new Map();
  if (config?.routes !== undefined) {
    if (!Array.isArray(config.routes)) throw new Error('routes must be an array');
    for(const route of config.routes) {
      if(typeof route?.preset!=='string'||!route.preset.trim()||
          route.preset.trim()!==route.preset||routes.has(route.preset))
        throw new Error('routes require unique nonempty preset IDs');
      routes.set(route.preset, selection(route));
    }
  }
  const presets = routes.size ? [...routes.keys()] : config?.presets??[];
  if (!Array.isArray(presets) ||
      presets.some(p=>typeof p!=='string' || !p.trim() || p.trim()!==p) ||
      new Set(presets).size!==presets.length) throw new Error('Invalid legacy preset IDs');
  for(const [preset,selected] of routes) installPin(ctx,{preset,...selected});
  if(presets.length) ctx.effect(() => ctx.tools.register(defineTool({
    name:'schedule_create_with_preset',
    description:'Create a new native scheduled task with a dedicated model/effort preset and a new session per run. Only call for a user-requested schedule with explicit title, prompt, time, and model preset.',
    parameters:{
      title:str('Task title'),
      prompt:str('Prompt-instruction to deliver'),
      rrule:str('DSH two-line DTSTART and RRULE text, with explicit time zone or UTC'),
      preset:{...str('Model and effort preset ID configured by the profile administrator'), enum:presets},
      cwd:{type:'string',description:'Optional explicit absolute path to an existing working directory; otherwise inherit the source session directory.'},
    },
    output:{
      schema:{type:'string'},
      render(_args,value) { return [{type:'text',text:value}]; }
    },
    async execute({title,prompt,rrule,preset,cwd:explicitCwd},exec) {
      if (!exec.agent || delegationDepthOf(exec.agent)>0)
        throw new Error('A root session must request this scheduled task.');
      const cwd=await scheduledWorkingDirectory(exec.agent,explicitCwd);
      exec.signal?.throwIfAborted();
      const task = await ctx.schedule.create({
        title,prompt,timing:{kind:'rrule',rrule},target:{kind:'new',create:{agentPreset:preset,...(cwd===undefined?{}:{cwd})}}
      },exec.agent.session.id,exec.signal);
      return JSON.stringify({id:task.id,preset,scheduledAt:task.scheduledAt});
    },
  })), 'schedule-model.creator');
  let overrides;
  ctx.inject(['profileContext','storageDomain','agents'], child => {
    const current=createScheduleOverrides(child);
    child.effect(() => {
      overrides=current;
      return () => { if(overrides===current)overrides=undefined; };
    }, 'schedule-model.override-state');
    child.effect(() => current.registerDeliveryHook(), 'schedule-model.override-delivery');
    child.effect(() => current.registerTool(resolveOwnedTask), 'schedule-model.override-tool');
    if(config?.managementPreset!==undefined)child.inject(['approval','typertGateway'], adminCtx => {
      adminCtx.effect(() => registerScheduleAdmin(adminCtx,current,{
        managementPreset:config.managementPreset,routes,
      }), 'schedule-model.host-owner-management');
      adminCtx.inject(['userQuestions','workspaceRegistry','sessionPersistence'], reuseCtx=>{
        reuseCtx.effect(()=>registerReuseAdmin(reuseCtx,{
          managementPreset:config.managementPreset,routes,prepareReceiving:prepareReceivingSessionModel,
          prepareDedicated:planDedicated,commitDedicated:applyDedicated,
        }), 'schedule-model.host-reused-session-management');
      });
    });
  });
  ctx.effect(() => registerNatural(ctx, routes), 'schedule-model.natural');
  ctx.systemPrompt.section({
    name:'tool:schedule-model-natural',
    order:ctx.systemPrompt.getSectionOrder('TOOL_SCHEDULE'),
    text:({scope})=>ctx.tools.get('schedule_create_with_model',scope)
      ?'For an existing task associated with this conversation, use schedule_update_model to change only the model or thinking level. In the management conversation, use the owner-approved schedule_admin_model_list and schedule_admin_model_batch_update for cross-conversation or multi-workspace requests. Preserve the recurrence and all other settings. For an explicit request to remove/reset an existing model override and restore the original preset/default, use schedule_clear_model. When showing a task, explain any pending reservation or skipped override, and do not describe a native receipt as model execution. Existing tasks that reuse a receiving session do not support a task-level override. In the management conversation use schedule_admin_change_reused_model, if available, to offer and approve the two distinct session options. Otherwise explain why no change was made. Never create or retarget an existing task as a workaround. For a NEW scheduled task with a specified model or thinking level, use schedule_create_with_model, not the standard scheduler. Pass the user’s model name/alias and thinking level; do not ask for preset IDs or RRULE. For every hour use intervalMinutes=60. For multiple exact times per day pass every local HH:mm in dailyTimes, plus timeZone; one task only. If the user explicitly specifies a working directory, pass its absolute path as cwd; otherwise omit it. Ask the user to pick if a model or level is ambiguous or unsupported; never fall back. Omit unspecified thinking to follow the selected model default. Do not create anything until timing and task content are clear.'
      :'',
  });
  ctx.effect(() => registerQuery(ctx, routes, task => overrides?.state(task)), 'schedule-model.query');
}

function registerNatural(ctx, routes){
  return ctx.tools.register(defineTool({
    name:'schedule_create_with_model',
    description:'Create a native DSH scheduled task with the requested model name/alias and requested thinking level. The model is selected only for a fresh task conversation. Prefer this when the user specifies a model or thinking level. Once, interval, and daily schedules are supported.',
    parameters:{
      title:str('User-facing task title; also the default title of the dedicated session'),
      sessionTitle:{type:'string',description:'Optional pinned title of the dedicated session. Only pass when the user requests a different session title.'},
      prompt:str('What the scheduled task should do'),
      model:str('Exact model ID/display name or user alias, e.g. ds. Never substitute an unspecified model.'),
      thinking:{type:'string',description:'Level requested by user, such as 低/low. Omit when user did not specify.'},
      intervalMinutes:{type:'number',description:'Repeat every N whole minutes. Hourly means 60.'},
      dailyTime:{type:'string',description:'For one daily time: local HH:mm:ss; requires timeZone.'},
      dailyTimes:{type:'array',items:{type:'string'},description:'For multiple times each day: exact local HH:mm strings, one per time; requires timeZone. Do not use with dailyTime.'},
      cwd:{type:'string',description:'Only when explicitly requested: absolute path to the existing working directory.'},
      timeZone:{type:'string',description:'For daily schedules, time zone identifying local time, e.g. Asia/Singapore.'},
      at:{type:'string',description:'For one-off schedules, RFC3339 timestamp with UTC offset.'},
    },
    output:{schema:{type:'string'},render(_args,value){return [{type:'text',text:value}];}},
    async execute(a,exec){
      if(!exec.agent||delegationDepthOf(exec.agent)>0)
        throw new Error('A root session must request this scheduled task.');
      const timing=naturalTiming(a);
      const title=a.title.trim();
      if(!title||title.length>120||!a.prompt.trim())
        throw new Error('Title and instructions are required. Title max length: 120.');
      const sessionTitle=a.sessionTitle?.trim()??title;
      if(a.sessionTitle!==undefined&&(!sessionTitle||sessionTitle.length>120))
        throw new Error('Session title must be nonempty and at most 120 characters.');
      // Custom hosts without the native title service still support existing callers.
      const titles=ctx.get('sessionTitle');
      if(a.sessionTitle!==undefined&&!titles)
        throw new Error('This DSH profile cannot set an explicit session title.');
      const resolved=resolveNatural(await ctx.sessionController.modelCatalog(),a.model,a.thinking);
      if(!resolved.selection) return JSON.stringify(resolved);
      const selected=resolved.selection;
      const routeError=await validateNaturalRoute(ctx.llm,selected,exec.signal);
      if(routeError)return JSON.stringify(routeError);
      exec.signal?.throwIfAborted();
      const create=await sessionCreationOptions(ctx,exec.agent,a.cwd,selected,routes);
      exec.signal?.throwIfAborted();
      const session=await ctx.sessionController.create(create);
      const {agent}=await ctx.sessionController.resolveAgent(session.sessionId);
      exec.signal?.throwIfAborted();
      // Do not call sessionController.selectModel: it also saves the global default.
      agent.model.select(selected);
      titles?.rename(agent.session,sessionTitle);
      if(!await ctx.sessions.flush(agent.session))
        throw new Error('Dedicated session model selection or title could not be persisted; no task created.');
      exec.signal?.throwIfAborted();
      const task=await ctx.schedule.create({
        title,prompt:a.prompt.trim(),timing,
        target:{kind:'session',sessionId:session.sessionId},
      },exec.agent.session.id,exec.signal);
      return JSON.stringify({id:task.id,scheduledAt:task.scheduledAt,configured:selected,
        target:{kind:'session',sessionId:session.sessionId},sessionReuse:true});
    },
  }));
}

async function sessionCreationOptions(ctx,agent,explicitCwd,selected,routes){
  const request={};
  const livePresets=agent.ctx?.get('agentPresets');
  const preset=livePresets?.composedPreset(agent.ctx);
  if(preset!==undefined){
    const forced=routes.get(preset);
    if(forced && (forced.provider!==selected.provider || forced.model!==selected.model ||
      forced.reasoningEffort!==selected.reasoningEffort))
      throw new Error('This conversation preset pins a conflicting model or thinking level. Switch to an unpinned preset and retry.');
    request.agentPreset=preset;
  }
  const cwd=await scheduledWorkingDirectory(agent,explicitCwd);
  if(cwd!==undefined){
    const workspace=await ctx.get('workspaceRegistry')?.resolveByPath(cwd);
    if(workspace===undefined)request.cwd=cwd;
    else request.workspaceId=workspace.id;
  }
  return request;
}

async function scheduledWorkingDirectory(agent,explicitCwd){
  const cwd=explicitCwd??agent.session.header.cwd;
  if(cwd===undefined)return undefined;
  if(!isAbsolute(cwd))throw new Error('Working directory must be an absolute path.');
  try{
    const resolved=await realpath(cwd);
    if(!(await stat(resolved)).isDirectory())throw new Error('not a directory');
    return resolved;
  }catch{throw new Error('Working directory does not exist or is not a directory. No task was created.');}
}

export function registerQuery(ctx, routes, overrideStateFor) {
  return ctx.tools.register(defineTool({
    name:'schedule_view_model',
    description:'Inspect the configured model and last recorded DSH model request for a scheduled task in this conversation. Use exact ID or title, never treat configuration as execution.',
    parameters:{
      identifier:str('Exact scheduled task ID or exact title'),
    },
    output:{
      schema:{type:'string'},
      render(_args,value){return [{type:'text',text:value}];},
    },
    async execute({identifier},exec){
      if(!exec.agent||delegationDepthOf(exec.agent)>0)
        throw new Error('A root session must request this inspection.');
      const sessionId=exec.agent.session.id;
      const {task,error}=await resolveOwnedTask(ctx.schedule,identifier.trim(),sessionId);
      if(error) return JSON.stringify(error);
      const preset=task.target.create?.agentPreset??null;
      const override=await overrideStateFor?.(task);
      let configured=override?.overrideStatus==='unreadable'?null:
        override?.configured??(preset===null?null:routes.get(preset)??null);
      let configuredSource=override?.configured?'override':configured?'preset':'native_or_unknown';
      if(!configured&&task.target.kind==='session'){
        try{
          configured=await configuredSessionModel(ctx.sessionController,task.target.sessionId,exec.signal);
          if(configured)configuredSource='session';
        }
        catch(error){exec.signal?.throwIfAborted();}
      }
      const delivery=task.lastDelivery;
      let latestRun={status:override?.pending?'pending_delivery':'no_recorded_delivery',requested:null,providerReturnedModel:null};
      if(delivery){
        try{
          latestRun={...await inspectLatest(ctx.sessionController,delivery,exec.signal),
            deliveredAt:delivery.deliveredAt};
        }catch(error){
          exec.signal?.throwIfAborted();
          latestRun={status:'history_unavailable',requested:null,providerReturnedModel:null,
            deliveredAt:delivery.deliveredAt};
        }
      }
      return JSON.stringify({id:task.id,title:task.title,preset,configured,configuredSource,latestRun,
        overrideStatus:override?.overrideStatus??'unavailable',pending:override?.pending??null,
        lastSkipped:override?.lastSkipped??null});
    },
  }));
}

function visible(task,sessionId){
  return task?.involvedSessionIds?.includes(sessionId)||
    task?.target?.sessionId===sessionId||task?.lastDelivery?.targetSessionId===sessionId;
}

async function resolveOwnedTask(schedule, key, sessionId){
  if(!key) return {error:{code:'not_found_in_session'}};
  if(key.startsWith('schedule-')){
    const task=await schedule.view({id:key});
    if(visible(task,sessionId)) return {task};
  }
  const matches=[];
  for(let offset=0;offset<5000;offset+=500){
    const page=await schedule.list({limit:500,offset});
    for(const item of page.items)
      if(item.title===key&&visible(item,sessionId))matches.push(item);
    if(matches.length>1)return {error:{code:'ambiguous_title',ids:matches.map(x=>x.id)}};
    if(offset+page.shown>=page.total||page.shown===0)
      return matches.length?{task:matches[0]}:{error:{code:'not_found_in_session'}};
  }
  return {error:{code:'use_exact_id'}};
}

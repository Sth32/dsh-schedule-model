import { apply as installPin, selection } from './index.js';
import { inspectLatest, configuredSessionModel } from './observe.js';
import { resolveNatural, naturalTiming } from './natural.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';

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
    },
    output:{
      schema:{type:'string'},
      render(_args,value) { return [{type:'text',text:value}]; }
    },
    async execute({title,prompt,rrule,preset},exec) {
      if (!exec.agent || delegationDepthOf(exec.agent)>0)
        throw new Error('A root session must request this scheduled task.');
      const task = await ctx.schedule.create({
        title,prompt,timing:{kind:'rrule',rrule},target:{kind:'new',create:{agentPreset:preset}}
      },exec.agent.session.id,exec.signal);
      return JSON.stringify({id:task.id,preset,scheduledAt:task.scheduledAt});
    },
  })), 'schedule-model.creator');
  ctx.effect(() => registerNatural(ctx), 'schedule-model.natural');
  ctx.systemPrompt.section({
    name:'tool:schedule-model-natural',
    order:ctx.systemPrompt.getSectionOrder('TOOL_SCHEDULE'),
    text:({scope})=>ctx.tools.get('schedule_create_with_model',scope)
      ?'When the user specifies a model or thinking level for a scheduled task, use schedule_create_with_model, not the standard scheduler. Pass the user’s model name/alias and thinking level; do not ask for preset IDs or RRULE. For every hour use intervalMinutes=60. Ask the user to pick if a model or level is ambiguous or unsupported; never fall back. Omit unspecified thinking to follow the selected model default. Do not create anything until timing and task content are clear.'
      :'',
  });
  ctx.effect(() => registerQuery(ctx, routes), 'schedule-model.query');
}

function registerNatural(ctx){
  return ctx.tools.register(defineTool({
    name:'schedule_create_with_model',
    description:'Create a native DSH scheduled task with the requested model name/alias and requested thinking level. The model is selected only for a fresh task conversation. Prefer this when the user specifies a model or thinking level. Once, interval, and daily schedules are supported.',
    parameters:{
      title:str('User-facing title'),
      prompt:str('What the scheduled task should do'),
      model:str('Exact model ID/display name or user alias, e.g. ds. Never substitute an unspecified model.'),
      thinking:{type:'string',description:'Level requested by user, such as 低/low. Omit when user did not specify.'},
      intervalMinutes:{type:'number',description:'Repeat every N whole minutes. Hourly means 60.'},
      dailyTime:{type:'string',description:'Repeat daily at local HH:mm:ss; requires timeZone.'},
      timeZone:{type:'string',description:'For daily schedules, time zone identifying local time, e.g. Asia/Singapore.'},
      at:{type:'string',description:'For one-off schedules, RFC3339 timestamp with UTC offset.'},
    },
    output:{schema:{type:'string'},render(_args,value){return [{type:'text',text:value}];}},
    async execute(a,exec){
      if(!exec.agent||delegationDepthOf(exec.agent)>0)
        throw new Error('A root session must request this scheduled task.');
      const timing=naturalTiming(a);
      if(!a.title.trim()||a.title.trim().length>120||!a.prompt.trim())
        throw new Error('Title and instructions are required. Title max length: 120.');
      const resolved=resolveNatural(await ctx.sessionController.modelCatalog(),a.model,a.thinking);
      if(!resolved.selection) return JSON.stringify(resolved);
      const selected=resolved.selection;
      await ctx.llm.resolveCallConfig(selected,exec.signal);
      exec.signal?.throwIfAborted();
      const cwd=exec.agent.session.header.cwd;
      const session=await ctx.sessionController.create(cwd===undefined?{}:{cwd});
      const {agent}=await ctx.sessionController.resolveAgent(session.sessionId);
      // Do not call sessionController.selectModel: it also saves the global default.
      agent.model.select(selected);
      if(!await ctx.sessions.flush(agent.session))
        throw new Error('Dedicated session model selection could not be persisted; no task created.');
      exec.signal?.throwIfAborted();
      const task=await ctx.schedule.create({
        title:a.title.trim(),prompt:a.prompt.trim(),timing,
        target:{kind:'session',sessionId:session.sessionId},
      },exec.agent.session.id,exec.signal);
      return JSON.stringify({id:task.id,scheduledAt:task.scheduledAt,configured:selected});
    },
  }));
}

export function registerQuery(ctx, routes) {
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
      let configured=preset===null?null:routes.get(preset)??null;
      if(!configured&&task.target.kind==='session'){
        try{configured=await configuredSessionModel(ctx.sessionController,task.target.sessionId,exec.signal);}
        catch(error){exec.signal?.throwIfAborted();}
      }
      const delivery=task.lastDelivery;
      let latestRun={status:'no_recorded_delivery',requested:null,providerReturnedModel:null};
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
      return JSON.stringify({id:task.id,title:task.title,preset,configured,latestRun});
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

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { resolveNatural } from './natural.js';
import { defineTool, delegationDepthOf } from './tool.js';

const taskIdPattern = /^schedule-[A-Za-z0-9_-]{1,100}$/;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const string = description => ({type:'string',required:true,description});
const exactSelection = (a,b) => a?.provider === b.provider && a?.model === b.model &&
  (a?.reasoningEffort??null) === (b.reasoningEffort??null);

function selection(value){
  if (!value || typeof value !== 'object' || !nonempty(value.provider) ||
      !nonempty(value.model) || (value.reasoningEffort !== undefined && !nonempty(value.reasoningEffort)))
    throw new Error('Invalid scheduled model selection.');
  return {provider:value.provider,model:value.model,
    ...(value.reasoningEffort===undefined?{}:{reasoningEffort:value.reasoningEffort})};
}

function createStore(profileDirectory){
  if (typeof profileDirectory!=='string'||!isAbsolute(profileDirectory))
    throw new Error('Scheduled model overrides require a DSH profile directory.');
  const dir=join(profileDirectory,'schedule-model-overrides');
  const path=id=>{
    if(typeof id!=='string'||!taskIdPattern.test(id))throw new Error('Invalid schedule identity.');
    return join(dir,id+'.json');
  };
  return {
    async read(id){
      const target=path(id);
      let serialized;
      try{serialized=await readFile(target,'utf8');}
      catch(error){if(error?.code==='ENOENT')return null;throw error;}
      const value=JSON.parse(serialized);
      if(value?.version!==1||value.scheduleId!==id)
        throw new Error('Invalid scheduled model override state.');
      return selection(value.selection);
    },
    async write(id,selected){
      const target=path(id);
      const serialized=JSON.stringify({version:1,scheduleId:id,selection:selection(selected)})+'\n';
      await mkdir(dir,{recursive:true,mode:0o700});
      const temporary=target+'.'+randomUUID()+'.tmp';
      try {
        const handle=await open(temporary,'wx',0o600);
        try{await handle.writeFile(serialized,'utf8');await handle.sync();}
        finally{await handle.close();}
        await rename(temporary,target);
      } finally {
        await unlink(temporary).catch(error=>{if(error?.code!=='ENOENT')throw error;});
      }
    },
  };
}

// DSH's public activation hook carries only the Session ID. Read the official
// storage diagnostic view for its exact pending reservation. Never open or
// mutate the scheduler domain. A historical receipt alone must not reroute a
// completed or reused Agent.
function freshReservation(ctx,sessionId){
  const domain=ctx.storageDomain.get('schedule');
  if(!domain)throw new Error('Schedule storage is not ready.');
  let result;
  for(const [,task] of domain.table('tasks').entries()){
    if(task.target.kind!=='new'||task.pendingDelivery?.targetSessionId!==sessionId)continue;
    if(result)throw new Error('Duplicate fresh Session reservation.');
    result=task;
  }
  return result;
}

export function createScheduleOverrides(ctx){
  const store=createStore(ctx.profileContext.dir);
  const queued=new Map();
  const serialize=(id,operation)=>{
    const previous=queued.get(id)??Promise.resolve();
    const current=previous.catch(()=>{}).then(operation);
    queued.set(id,current);
    const clear=()=>{if(queued.get(id)===current)queued.delete(id);};
    current.then(clear,clear);
    return current;
  };

  return {
    configured(task){return task.target.kind==='new'?store.read(task.id):Promise.resolve(null);},
    registerDeliveryHook(){
      return ctx.on('schedule/resolve-agent',async (sessionId,next)=>{
        const reserved=freshReservation(ctx,sessionId);
        if(!reserved)return next();
        const selected=await store.read(reserved.record.id);
        if(!selected)return next();
        // Validate before activation and persist on the reserved Agent before
        // returning to the native scheduler, which queues its reminder then.
        await ctx.llm.resolveCallConfig(selected);
        const agent=await next();
        if(agent.session.id!==sessionId)throw new Error('Scheduled model override target did not match the reservation.');
        const boundary=ctx.agents.turnBoundaryOf(agent.session);
        const started=boundary.lastTurn!==0||boundary.openTurnStartSeq!==null||
          agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length;
        if(started&&!exactSelection(agent.model.current(),selected))
          throw new Error('Cannot change a scheduled model after the reserved Session has started or received input.');
        // Pin even when an untouched Agent currently resolves to this same default.
        // An already-started retry may only keep an exactly matching model.
        if(!started)agent.model.select(selected);
        if(!await ctx.sessions.flush(agent.session))
          throw new Error('Unable to persist the scheduled model override before delivery.');
        return agent;
      });
    },
    registerTool(resolveOwnedTask){
      return ctx.tools.register(defineTool({
        name:'schedule_update_model',
        description:'Change only the model and optional thinking level of an existing schedule visible in this conversation when it already creates a fresh session every run. Do not change its prompt, timing, preset or destination. Ask first if the exact task is ambiguous; never create a replacement or switch targets.',
        parameters:{
          identifier:string('Exact schedule ID or exact title'),
          model:string('Exact configured model ID, model name or user model alias'),
          thinking:{type:'string',description:'Requested thinking level, such as 低/low; omit to use the chosen model default'},
        },
        output:{schema:{type:'string'},render(_args,value){return [{type:'text',text:value}];}},
        async execute(args,exec){
          if(!exec.agent||delegationDepthOf(exec.agent)>0)
            throw new Error('A root session must request a scheduled model change.');
          const key=args.identifier.trim();
          const actorSessionId=exec.agent.session.id;
          const initial=await resolveOwnedTask(ctx.schedule,key,actorSessionId);
          if(initial.error)return JSON.stringify(initial.error);
          if(initial.task.target.kind!=='new')return JSON.stringify({code:'requires_fresh_session_target',id:initial.task.id});
          const resolved=resolveNatural(await ctx.sessionController.modelCatalog(),args.model,args.thinking);
          if(!resolved.selection)return JSON.stringify(resolved);
          const selected=resolved.selection;
          await ctx.llm.resolveCallConfig(selected,exec.signal);
          return serialize(initial.task.id,async()=>{
            exec.signal?.throwIfAborted();
            const current=await resolveOwnedTask(ctx.schedule,initial.task.id,actorSessionId);
            if(current.error)return JSON.stringify(current.error);
            if(current.task.id!==initial.task.id||current.task.target.kind!=='new')
              return JSON.stringify({code:'schedule_target_changed',id:initial.task.id});
            exec.signal?.throwIfAborted();
            await store.write(initial.task.id,selected);
            return JSON.stringify({id:initial.task.id,configured:selected,
              appliesTo:'fresh deliveries that have not yet selected their route'});
          });
        },
      }));
    },
  };
}

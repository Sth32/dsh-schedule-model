import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { resolveNatural, validateNaturalRoute } from './natural.js';
import { defineTool, delegationDepthOf } from './tool.js';

const taskIdPattern = /^schedule-[A-Za-z0-9_-]{1,100}$/;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const string = description => ({type:'string',required:true,description});
const exactSelection = (a,b) => !!a&&!!b&&a.provider===b.provider&&a.model===b.model&&
  (a.reasoningEffort??null)===(b.reasoningEffort??null);
const reasons=new Set(['override_unreadable','route_unavailable','session_already_started','selection_failed','selection_not_persisted']);
const output={schema:{type:'string'},render(_args,value){return [{type:'text',text:value}];}};

function selection(value){
  if(!value||typeof value!=='object'||!nonempty(value.provider)||!nonempty(value.model)||
      (value.reasoningEffort!==undefined&&!nonempty(value.reasoningEffort)))
    throw new Error('Invalid scheduled model selection.');
  return {provider:value.provider,model:value.model,
    ...(value.reasoningEffort===undefined?{}:{reasoningEffort:value.reasoningEffort})};
}

function createStore(profileDirectory){
  if(typeof profileDirectory!=='string'||!isAbsolute(profileDirectory))
    throw new Error('Scheduled model overrides require a DSH profile directory.');
  const dir=join(profileDirectory,'schedule-model-overrides');
  const path=(id,kind)=>{
    if(typeof id!=='string'||!taskIdPattern.test(id))throw new Error('Invalid schedule identity.');
    return join(dir,id+(kind==='issue'?'.issue.json':'.json'));
  };
  function decode(value,id){
    if(value?.version!==1||value.scheduleId!==id)throw new Error('Invalid scheduled model override state.');
    return value;
  }
  async function read(id,kind){
    let serialized;
    try{serialized=await readFile(path(id,kind),'utf8');}
    catch(error){if(error?.code==='ENOENT')return null;throw error;}
    return decode(JSON.parse(serialized),id);
  }
  async function remove(id,kind){
    try{await unlink(path(id,kind));return true;}
    catch(error){if(error?.code==='ENOENT')return false;throw error;}
  }
  async function write(id,kind,data){
    const target=path(id,kind);
    const serialized=JSON.stringify({version:1,scheduleId:id,...data})+'\n';
    await mkdir(dir,{recursive:true,mode:0o700});
    const temporary=target+'.'+randomUUID()+'.tmp';
    try{
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(serialized,'utf8');await handle.sync();}
      finally{await handle.close();}
      await rename(temporary,target);
    }finally{
      await unlink(temporary).catch(error=>{if(error?.code!=='ENOENT')throw error;});
    }
  }
  return {
    async read(id){const value=await read(id);return value===null?null:selection(value.selection);},
    write:(id,selected)=>write(id,null,{selection:selection(selected)}),
    remove,
    async issue(id){
      const value=await read(id,'issue');
      if(value===null)return null;
      if(!nonempty(value.sessionId)||!reasons.has(value.reason)||!Number.isFinite(Date.parse(value.at)))
        throw new Error('Invalid scheduled model diagnostic.');
      return {sessionId:value.sessionId,reason:value.reason,at:value.at,deliveryContinues:value.deliveryContinues===true};
    },
    writeIssue:(id,value)=>write(id,'issue',value),
  };
}

function rows(ctx){
  const domain=ctx.storageDomain.get('schedule');
  if(!domain)throw new Error('Schedule storage is not ready.');
  return domain.table('tasks');
}

function reservation(ctx,sessionId){
  let result;
  for(const [,task] of rows(ctx).entries()){
    if(task.target.kind!=='new'||task.pendingDelivery?.targetSessionId!==sessionId)continue;
    if(result)throw new Error('Duplicate fresh Session reservation.');
    result=task;
  }
  return result;
}
function authoritativeTask(ctx,id){
  for(const [key,task] of rows(ctx).entries())if(key===id)return task;
}

export function createScheduleOverrides(ctx){
  const store=createStore(ctx.profileContext.dir);
  const queued=new Map();
  const warn=(text)=>ctx.logger?.warn('schedule-model: '+text);
  const serialize=(id,operation)=>{
    const previous=queued.get(id)??Promise.resolve();
    const current=previous.catch(()=>{}).then(operation);
    queued.set(id,current);
    const clear=()=>{if(queued.get(id)===current)queued.delete(id);};
    current.then(clear,clear);
    return current;
  };
  async function skip(task,sessionId,reason,deliveryContinues=false){
    const issue={sessionId,reason,at:new Date().toISOString(),deliveryContinues};
    try{await store.writeIssue(task.record.id,issue);}
    catch{
      warn(`could not persist delivery diagnostic for ${task.record.id}`);
      if(!deliveryContinues)
        throw Error('Unable to record the scheduled model problem safely; the native delivery remains reserved.');
    }
    warn(`${task.record.id}: ${reason}; ${deliveryContinues?'native route retained':'delivery remains reserved'}`);
    if(!deliveryContinues)
      throw Error(`Scheduled model override blocked (${reason}); retry after repairing or clearing this task’s override.`);
  }
  function deliverStatus(raw,issue){
    const pending=raw?.pendingDelivery?.targetSessionId??null;
    return {pending:pending?{status:'reserved',targetSessionId:pending}:null,
      lastSkipped:issue===null?null:{status:issue.deliveryContinues?'kept_existing_route':'blocked_before_delivery',reason:issue.reason,
        at:issue.at,targetSessionId:issue.sessionId}};
  }

  return {
    configured(task){return task.target.kind==='new'?store.read(task.id):Promise.resolve(null);},
    async state(task){
      if(task.target.kind!=='new')return {configured:null,overrideStatus:'not_applicable',pending:null,lastSkipped:null};
      let row,issue=null,configured=null,overrideStatus='none';
      try{row=authoritativeTask(ctx,task.id);}catch{}
      try{issue=await store.issue(task.id);}catch{}
      try{configured=await store.read(task.id);if(configured)overrideStatus='configured';}
      catch{overrideStatus='unreadable';}
      return {configured,overrideStatus,...deliverStatus(row,issue)};
    },
    registerDeliveryHook(){
      return ctx.on('schedule/resolve-agent',async(sessionId,next)=>{
        const row=reservation(ctx,sessionId);
        if(!row)return next();
        // Propagate native activation errors; the upstream uses not-found to
        // create a missing reserved Session. Override failures are reported separately.
        const agent=await next();
        if(agent.session.id!==sessionId)throw new Error('Scheduled model override target did not match the reservation.');
        let selected;
        try{selected=await store.read(row.record.id);}
        catch{await skip(row,sessionId,'override_unreadable');return agent;}
        if(!selected)return agent;
        const alreadyStarted=()=>{
          const boundary=ctx.agents.turnBoundaryOf(agent.session);
          return boundary.lastTurn!==0||boundary.openTurnStartSeq!==null||
            agent.status!=='idle'||agent.inbox.nextTurn.length>0;
        };
        // A startup plugin can queue briefing for the next step without
        // starting a turn. A running driver, actual turn, or queued waking
        // input is different and must not have its model replaced.
        if(alreadyStarted()&&!exactSelection(agent.model.current(),selected)){
          await skip(row,sessionId,'session_already_started',true);return agent;
        }
        try{await ctx.llm.resolveCallConfig(selected);}
        catch{await skip(row,sessionId,'route_unavailable');return agent;}
        const started=alreadyStarted();
        const previous=agent.model.current();
        if(started&&!exactSelection(previous,selected)){
          await skip(row,sessionId,'session_already_started',true);return agent;
        }
        try{if(!started)agent.model.select(selected);}
        catch{await skip(row,sessionId,'selection_failed');return agent;}
        try{
          if(!await ctx.sessions.flush(agent.session))throw Error('not persisted');
        }catch{
          if(!started&&previous&&!alreadyStarted()){
            try{agent.model.select(previous);}catch{}
          }
          await skip(row,sessionId,'selection_not_persisted');
        }
        return agent;
      });
    },
    registerTool(resolveOwnedTask){
      const mutate=(operation,resolve)=>defineTool({
        name:operation==='clear'?'schedule_clear_model':'schedule_update_model',
        description:operation==='clear'
          ?'Remove the existing model override from an owned fresh-session scheduled task, restoring its original preset/default for future deliveries. Do not edit the task or its history.'
          :'Change only the model and optional thinking level of an owned existing schedule that creates a fresh session each run. Do not replace or retarget it.',
        parameters:{identifier:string('Exact schedule ID or exact title'),
          ...(operation==='clear'?{}:{model:string('Exact configured model ID, model name or user model alias'),
            thinking:{type:'string',description:'Requested thinking level (e.g. 低/low); omit for model default'}})},
        output,
        async execute(args,exec){
          if(!exec.agent||delegationDepthOf(exec.agent)>0)
            throw new Error('A root session must request a scheduled model change.');
          const actor=exec.agent.session.id;
          const initial=await resolveOwnedTask(ctx.schedule,args.identifier.trim(),actor);
          if(initial.error)return JSON.stringify(initial.error);
          const id=initial.task.id;
          if(initial.task.target.kind!=='new')return JSON.stringify({code:'requires_fresh_session_target',id});
          const prepared=await resolve(args,exec);
          if(prepared?.error)return JSON.stringify(prepared.error);
          return serialize(id,async()=>{
            exec.signal?.throwIfAborted();
            const current=await resolveOwnedTask(ctx.schedule,id,actor);
            if(current.error)return JSON.stringify(current.error);
            if(current.task.id!==id||current.task.target.kind!=='new')
              return JSON.stringify({code:'schedule_target_changed',id});
            exec.signal?.throwIfAborted();
            if(operation==='clear'){
              const cleared=await store.remove(id);
              return JSON.stringify({id,cleared,restored:'native_preset_or_default',
                appliesTo:'fresh deliveries that have not yet selected their route'});
            }
            await store.write(id,prepared.selection);
            return JSON.stringify({id,configured:prepared.selection,
              appliesTo:'fresh deliveries that have not yet selected their route'});
          });
        },
      });
      const disposeUpdate=ctx.tools.register(mutate('update',async(args,exec)=>{
        const resolved=resolveNatural(await ctx.sessionController.modelCatalog(),args.model,args.thinking);
        if(!resolved.selection)return {error:resolved};
        const error=await validateNaturalRoute(ctx.llm,resolved.selection,exec.signal);
        return error?{error}:resolved;
      }));
      const disposeClear=ctx.tools.register(mutate('clear',async()=>null));
      return ()=>{disposeClear();disposeUpdate();};
    },
  };
}

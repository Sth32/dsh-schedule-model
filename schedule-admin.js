// Opt-in Host-wide schedule management. Authority is the Host's own browser
// approval bridge, not the prompt, a supplied session identity, or a promise.
import { isDeepStrictEqual } from 'node:util';
import { configuredSessionModel } from './observe.js';
import { classifyScheduleWorkspace } from './workspace-scope.js';
import { resolveNatural, validateNaturalRoute } from './natural.js';
import { defineTool, delegationDepthOf } from './tool.js';

const MAX_BATCH=10;
const MAX_PAGE=25;
const APPROVAL_MS=120000;
const validId=id=>typeof id==='string'&&/^schedule-[A-Za-z0-9_-]{1,100}$/.test(id);
const output={schema:{type:'string'},render(_args,value){return [{type:'text',text:value}];}};
const block=code=>JSON.stringify({code});
const shown=value=>JSON.stringify(String(value??'').replace(/[\p{Cc}\p{Cf}]/gu,' '));
const routeText=route=>route===null?'native preset/default':`${shown(route.provider)} / ${shown(route.model)} [${route.reasoningEffort===undefined?'adapter default':shown(route.reasoningEffort)}]`;
const snapshot=task=>({
  id:task.id,title:task.title,status:task.status,updatedAt:task.updatedAt??null,target:structuredClone(task.target),
});

export function registerScheduleAdmin(ctx,overrides,{managementPreset,routes=new Map(),approvalMs=APPROVAL_MS}){
  if(typeof managementPreset!=='string'||!managementPreset||managementPreset.trim()!==managementPreset)
    throw Error('Schedule model Host-wide management requires an explicitly configured Agent preset.');
  function inScope(agent,ordinaryTool,toolSet){
    return !!agent&&delegationDepthOf(agent)===0&&
      agent.ctx?.get('agentPresets')?.composedPreset(agent.ctx)===managementPreset&&
      !!ctx.tools.get(ordinaryTool,agent,toolSet);
  }
  const ownerLive=()=>ctx.typertGateway.hasLiveClient()===true;
  function callerReady(exec,ordinaryTool){
    return typeof exec.callId==='string'&&!!exec.callId&&inScope(exec.agent,ordinaryTool,exec.toolSet)&&ownerLive();
  }
  async function ask(exec,toolName,reason){
    if(!ownerLive()||exec.signal.aborted)return false;
    const signal=AbortSignal.any([exec.signal,AbortSignal.timeout(approvalMs)]);
    try{
      const result=await ctx.approval.request({agent:exec.agent,toolName,callId:exec.callId,
        reason,displayReason:{en:reason,zh:reason},signal});
      return result==='allowed-once'&&!signal.aborted;
    }catch{return false;}
  }
  const readName='schedule_admin_model_list';
  const disposeRead=ctx.tools.register(defineTool({
    name:readName,
    description:'Inspect Host-wide scheduled task model configuration and targets. Use only for explicitly requested central management from the configured owner management preset. Native browser approval is required before revealing results; no prompts, paths or conversation transcripts.',
    parameters:{
      offset:{type:'number',description:'Optional page start, default 0.'},
      limit:{type:'number',description:'Optional rows per page, default 25, maximum 25.'},
    },
    output,
    presentCall:()=>({card:'generic',title:'Inspect scheduled model inventory',kind:'read'}),
    async execute({offset=0,limit=MAX_PAGE},exec){
      if(!callerReady(exec,'schedule_list'))return block('owner_ui_approval_unavailable');
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>MAX_PAGE)
        return block('invalid_page');
      if(!await ask(exec,readName,`Show Host-wide scheduled task names, IDs, types, statuses and model settings, rows ${offset+1}–${offset+limit}; no prompts or transcripts. / 查看这些任务的模型设置（不含提示词和对话内容）。`))
        return block('owner_ui_approval_not_granted');
      if(!inScope(exec.agent,'schedule_list',exec.toolSet))return block('management_scope_changed');
      exec.signal.throwIfAborted();
      const page=await ctx.schedule.list({offset,limit});
      const items=await Promise.all(page.items.map(async task=>{
        const kind=task.target.kind;
        const preset=task.target.create?.agentPreset??null;
        const state=await overrides.state(task);
        let configured=state.overrideStatus==='unreadable'?null:state.configured??(preset===null?null:routes.get(preset)??null);
        let configuredSource=state.configured?'override':configured?'preset':'native_or_unknown';
        // Only extract a durable route (never emit or log the event contents).
        if(kind==='session'){
          try{
            configured=await configuredSessionModel(ctx.sessionController,task.target.sessionId,exec.signal);
            if(configured)configuredSource='session';
          }catch{exec.signal.throwIfAborted();}
        }
        const workspace=await classifyScheduleWorkspace(ctx.get?.('workspaceRegistry'),task,exec.agent.session.id);
        return {id:task.id,title:task.title,status:task.status,targetKind:kind,preset,workspace,
          configurable:kind==='new',configured,configuredSource,
          overrideStatus:state.overrideStatus,lastDeliveryAt:task.lastDelivery?.deliveredAt??null};
      }));
      exec.signal.throwIfAborted();
      const currentHostDefault=ctx.get?.('agentDefaultModel')?.currentSelection()??null;
      return JSON.stringify({items,total:page.total,offset,limit,currentHostDefault});
    },
  }),{when:({agent})=>inScope(agent,'schedule_list')});
  try{
    const writeName='schedule_admin_model_batch_update';
    const disposeWrite=ctx.tools.register(defineTool({
      name:writeName,
      description:'Owner-approved Host-wide set or clear of the model and thinking level for up to ten exact existing task IDs. They must already start a new session every run. Never retarget/recreate tasks. Any failed preflight blocks the full batch; after approval races or storage errors can produce explicitly reported partial completion.',
      parameters:{
        ids:{type:'array',items:{type:'string'},required:true,description:'1–10 distinct exact schedule IDs. Never pass titles.'},
        action:{type:'string',enum:['set','clear'],description:'Set by default; clear only on an explicit request to restore native preset/default.'},
        model:{type:'string',description:'Exact configured model or provider/model route. Required when setting; omit for clear.'},
        thinking:{type:'string',description:'Requested reasoning level; omission uses the adapter default.'},
      },
      output,
      presentCall:args=>Array.isArray(args?.ids)?({
        card:'generic',title:'Change the scheduled model for exact tasks',kind:'edit',
        rawInput:args.action==='clear'?{ids:args.ids,action:'clear'}:
          {ids:args.ids,model:args.model,thinking:args.thinking??'adapter default'},
      }):undefined,
      async execute({ids,model,thinking,action='set'},exec){
        if(!callerReady(exec,'schedule_edit'))return block('owner_ui_approval_unavailable');
        if(ids.length<1||ids.length>MAX_BATCH||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)
          return block('invalid_exact_task_ids');
        if(action==='clear'?(model!==undefined||thinking!==undefined):!model?.trim())
          return block('inconsistent_model_action');
        let selected=null;
        if(action==='set'){
          const resolved=resolveNatural(await ctx.sessionController.modelCatalog(),model,thinking);
          if(!resolved.selection)return JSON.stringify(resolved);
          selected=Object.freeze(resolved.selection);
          if(Object.values(selected).some(value=>value.length>160||/[\p{Cc}\p{Cf}]/u.test(value)))
            return block('route_not_safe_to_present');
          const invalid=await validateNaturalRoute(ctx.llm,selected,exec.signal);
          if(invalid)return JSON.stringify(invalid);
        }
        const plan=[];
        const refused=[];
        for(const id of ids){
          exec.signal.throwIfAborted();
          const task=await ctx.schedule.view({id});
          if(task?.id!==id||!task.target){refused.push({id,code:'task_not_found'});continue;}
          if(task.target.kind!=='new'){refused.push({id,code:'requires_fresh_session_target'});continue;}
          try{plan.push({task:snapshot(task),before:await overrides.configured(task)});}
          catch{refused.push({id,code:'override_unreadable'});}
        }
        // Do not expose query / eligibility results about other tasks before
        // the owner has authorized a central inventory page.
        if(refused.length)return block('batch_preflight_rejected_no_changes');
        const rows=plan.map(({task,before},index)=>
          `${index+1}. ${shown(task.id)} ${shown(task.title)}: ${routeText(before)}`);
        const label=action==='clear'?'Restore native preset/default':'Change scheduled model';
        const reason=`${label} for these ${plan.length} existing fresh-session tasks: ${routeText(selected)}. `
          +`Keep task IDs, times and targets. Old overrides: ${rows.join(' | ')}`;
        if(!await ask(exec,writeName,reason))return block('owner_ui_approval_not_granted');
        if(!inScope(exec.agent,'schedule_edit',exec.toolSet))return block('management_scope_changed');
        const results=[];
        for(const row of plan){
          const {id}=row.task;
          if(exec.signal.aborted){results.push({id,status:'not_changed',code:'cancelled'});continue;}
          if(!inScope(exec.agent,'schedule_edit',exec.toolSet)){
            results.push({id,status:'not_changed',code:'management_scope_changed'});continue;
          }
          try{
            if(selected!==null){
              const invalid=await validateNaturalRoute(ctx.llm,selected,exec.signal);
              if(invalid){results.push({id,status:'not_changed',code:invalid.code});continue;}
            }
            const status=await overrides.commitConfirmed(id,selected,exec.signal,async()=>{
              const task=await ctx.schedule.view({id});
              return task?.id===id&&task.target?.kind==='new'&&isDeepStrictEqual(snapshot(task),row.task);
            },row.before);
            results.push(status==='changed'||status==='unchanged'?{id,status,configured:selected}:{id,status:'not_changed',code:status});
          }catch{results.push({id,status:'not_changed',code:exec.signal.aborted?'cancelled':'write_failed'});}
        }
        const changed=results.filter(row=>row.status==='changed').length;
        const succeeded=results.filter(row=>row.status!=='not_changed').length;
        return JSON.stringify({status:succeeded===results.length?'complete':succeeded?'partial':'none',changed,results});
      },
    }),{when:({agent})=>inScope(agent,'schedule_edit')});
    const removeGuidance=ctx.systemPrompt?.section({
      name:'tool:schedule-model-management',
      order:ctx.systemPrompt.getSectionOrder('TOOL_SCHEDULE'),
      text:({scope})=>inScope(scope,'schedule_list')
        ?'For an explicit request to inspect models across workspaces use schedule_admin_model_list. Ask the owner to approve the native browser dialog. Use that approved inventory to resolve names to exact IDs; ask about duplicate names and do not require the person to type an ID when you can identify it. To set or explicitly clear the model for one or more existing tasks using a fresh session on every run, request schedule_admin_model_batch_update with their exact IDs, then wait for native owner approval. Do not recreate or retarget unsupported tasks. Never infer approval from chat. Report partial results precisely.'
        :'',
    });
    return ()=>{if(typeof removeGuidance==='function')removeGuidance();disposeWrite();disposeRead();};
  }catch(error){disposeRead();throw error;}
}

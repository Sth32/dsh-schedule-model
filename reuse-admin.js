// The model can request a review, but cannot select either operation. The
// Host owner chooses from an immutable server-side plan and approves the
// selected scope using the existing native one-shot approval policy.
import {resolveNatural,validateNaturalRoute} from './natural.js';
import {defineTool,delegationDepthOf} from './tool.js';

const name='schedule_admin_change_reused_model';
const questionId='schedule-model-reused-choice';
const keepLabel='改原会话 / Change original session';
const newLabel='新开专用会话 / Open dedicated session';
const cancelLabel='不修改 / Cancel';
const validId=id=>typeof id==='string'&&/^schedule-[A-Za-z0-9_-]{1,100}$/.test(id);
const cancel=code=>JSON.stringify({status:'not_changed',code});
const print=value=>JSON.stringify(String(value??'').replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,240));
const route=value=>value?.model
  ?`${print(value.provider)} / ${print(value.model)} [${value.reasoningEffort==null?'供应商默认档 / adapter default':print(value.reasoningEffort)}]`
  :'未核实 / not verified';
// Native question details render Markdown; keep task titles/model IDs as text.
// Native approval itself presents plain text.
const markdownText=value=>value.replace(/[\\`*_{}\[\]#<>|~]/g,'\\$&');
const taskLabel=task=>`${print(task.title)} (${task.id})`;
const keepImpact=plan=>[
  `仅修改原接收会话 ${print(plan.sessionTitle??'')} (${plan.sessionId})，不新建会话，DSH 切模型时仍可能压缩上下文；后续手动对话与下列共用任务一起使用新模型。`,
  'Existing conversation stays (DSH may compact its history on a model switch). Future manual messages and the listed schedules share the new route.',
  `原模型 → 新模型 / Before → After: ${route(plan.from)} → ${route(plan.to)}`,
  ...plan.affectedTasks.map(task=>`• ${taskLabel(task)}`),
].join('\n');
const newImpact=(task,selected,impact,before)=>[
  `只把 ${taskLabel(task)} 切换到一个新开的专用会话。它以后复用该会话，不复制旧对话上下文；旧会话及其他任务不动。原任务 ID、时间规则和历史保留。`,
  'Retarget only this task to a blank dedicated conversation. It is reused for later runs. Existing history and other tasks remain unchanged.',
  `旧会话 / Old session: ${task.target.sessionId}; 原模型 → 新模型 / Before → After: ${route(before)} → ${route(selected)}`,
  impact?.workspaceTitle? `工作区 / Workspace: ${print(impact.workspaceTitle)}`:'',
  impact?.preset? `预设 / Preset: ${print(impact.preset)}`:'',
].filter(Boolean).join('\n');
const notAvailable=code=>{
  const special={
    open_receiving_session_first:'原会话不在线，可在 DSH 打开它后再试 / Open the original conversation first',
    receiving_session_busy:'原会话有进行中或排队的输入 / The original conversation is busy',
    receiving_session_scheduled_work_pending:'原会话有定时任务正在执行或即将投递 / Scheduled work is active or due',
    receiving_session_route_persistence_unsupported:'原会话使用无法保证持久化的预设或固定模型 / The preset may override this model on restart',
    preset_pin_conflict:'目标预设固定了其他模型 / The target preset pins a different model',
    target_unavailable:'目标会话不可用 / The receiving conversation is not available',
  };
  return special[code]??`当前条件下无法安全执行 / Not safe in the current state (${print(code??'unavailable')})`;
};

function selectedOption(answer,options){
  const rows=answer?.answers;
  if(!Array.isArray(rows)||rows.length!==1)return null;
  const row=rows[0];
  if(row?.id!==questionId||!Array.isArray(row.selected)||row.selected.length!==1||
     row.custom!==undefined)return null;
  return options.includes(row.selected[0])?row.selected[0]:null;
}

export function registerReuseAdmin(ctx,{managementPreset,routes,prepareReceiving,prepareDedicated,commitDedicated,
  waitMs=120_000}){
  const scoped=(agent,toolSet)=>!!agent&&delegationDepthOf(agent)===0&&
    agent.ctx?.get('agentPresets')?.composedPreset(agent.ctx)===managementPreset&&
    !!ctx.tools.get('schedule_edit',agent,toolSet);
  const live=()=>ctx.typertGateway.hasLiveClient()===true;
  const disposeTool=ctx.tools.register(defineTool({
    name,
    description:'Offer the owner two explicit ways to change the model of one exact existing schedule whose receiving session is reused. DSH shows both scopes and asks the owner to select one, then to authorize the selected change. Never infer approval from chat. Do not use schedule_edit or the model selector as a fallback.',
    parameters:{
      id:{type:'string',required:true,description:'Exact task ID from the approved schedule model inventory.'},
      model:{type:'string',required:true,description:'Requested model or exact provider/model route.'},
      thinking:{type:'string',description:'Reasoning level; omit to use the provider default.'},
    },
    output:{schema:{type:'string'},render(_args,value){return [{type:'text',text:value}];}},
    presentCall:()=>({card:'generic',title:'Review the receiving session model options',kind:'edit'}),
    async execute({id,model,thinking},exec){
      if(!exec.signal||typeof exec.callId!=='string'||!exec.callId||!scoped(exec.agent,exec.toolSet)||!live())
        return cancel('owner_ui_approval_unavailable');
      if(!validId(id)||model.length>300||(thinking?.length??0)>100)return cancel('invalid_exact_task_or_model');
      exec.signal.throwIfAborted();
      const verifyScope=()=>!exec.signal.aborted&&live()&&scoped(exec.agent,exec.toolSet);
      const task=await ctx.schedule.view({id});
      // A pending new_once target does not already have a receiving Session.
      if(task?.id!==id||task.target?.kind!=='session')return cancel('review_requires_existing_reused_session');
      const wanted=resolveNatural(await ctx.sessionController.modelCatalog(),model,thinking);
      if(!wanted.selection)return JSON.stringify(wanted);
      const to=Object.freeze(wanted.selection);
      if(Object.values(to).some(value=>value.length>160||/[\p{Cc}\p{Cf}]/u.test(value)))
        return cancel('route_not_safe_to_present');
      const invalid=await validateNaturalRoute(ctx.llm,to,exec.signal);
      if(invalid)return JSON.stringify(invalid);
      const [keep,move]=await Promise.all([
        prepareReceiving(ctx,{id,selection:to,actor:exec.agent,routes,signal:exec.signal}),
        prepareDedicated(ctx,task,to,exec.signal,{routes}),
      ]);
      if(!verifyScope())return cancel('management_scope_changed');
      const keepReady=keep?.plan?.taskId===id&&keep.plan.sessionId===task.target.sessionId&&typeof keep.commit==='function';
      const moveReady=move?.ok===true;
      const keepDetail=keepReady?keepImpact(keep.plan):notAvailable(keep?.code);
      const moveDetail=moveReady?newImpact(task,to,move.impact,keepReady?keep.plan.from:null):notAvailable(move?.code);
      const options=[
        ...(keepReady?[{label:keepLabel,description:'保留原上下文，整个接收会话换模型 / Preserve context; change the entire receiving session'}]:[]),
        ...(moveReady?[{label:newLabel,description:'仅切换这条任务，新会话无旧上下文 / Only retarget this task; no old context copied'}]:[]),
        {label:cancelLabel,description:'保留现状 / Keep everything as is'},
      ];
      const detail=`${keepLabel}\n${keepDetail}\n\n${newLabel}\n${moveDetail}`;
      const chooseSignal=AbortSignal.any([exec.signal,AbortSignal.timeout(waitMs)]);
      let picked;
      try{
        const answer=await ctx.userQuestions.ask({agent:exec.agent,signal:chooseSignal,questions:[{
          id:questionId,header:'换用模型 / Change model',
          question:`为 ${taskLabel(task)} 选择要确认的方案 / Select a change to review`,
          detail:markdownText(detail),options,multiSelect:false,
        }]});
        if(!chooseSignal.aborted)picked=selectedOption(answer,options.map(item=>item.label));
      }catch{return cancel('owner_choice_unavailable');}
      if(!picked||picked===cancelLabel)return cancel('no_change_selected');
      if(!verifyScope())return cancel('management_scope_changed');
      const reason=picked===keepLabel?keepDetail:moveDetail;
      const approvalSignal=AbortSignal.any([exec.signal,AbortSignal.timeout(waitMs)]);
      let decision;
      try{
        decision=await ctx.approval.request({agent:exec.agent,toolName:name,callId:exec.callId,
          reason,displayReason:{zh:reason,en:reason},signal:approvalSignal});
      }catch{return cancel('owner_ui_approval_not_granted');}
      if(decision!=='allowed-once'||approvalSignal.aborted||!verifyScope())
        return cancel('owner_ui_approval_not_granted');
      if(picked===keepLabel)return JSON.stringify(await keep.commit({signal:exec.signal,verifyScope}));
      if(picked===newLabel)return JSON.stringify(await commitDedicated(ctx,move.plan,exec.signal,{verifyScope}));
      return cancel('no_change_selected');
    },
  }),{when:({agent})=>scoped(agent)});
  const disposeGuide=ctx.systemPrompt?.section({
    name:'tool:schedule-model-reused-options',order:ctx.systemPrompt.getSectionOrder('TOOL_SCHEDULE'),
    text:({scope})=>scoped(scope)
      ?'For one exact existing schedule whose target reuses a receiving session, after authorized inventory identifies it, use schedule_admin_change_reused_model for an explicitly requested model change. It shows both options to the owner and independently confirms only their chosen scope. If either option is unavailable, explain it; never infer consent, recreate the task, or invoke schedule_edit or the ordinary model selector as a workaround. Fresh-session model updates still use the existing batch tool.'
      :'',
  });
  return ()=>{if(typeof disposeGuide==='function')disposeGuide();disposeTool();};
}

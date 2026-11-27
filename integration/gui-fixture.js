import {appendFileSync,mkdirSync} from 'node:fs';
import {installStartupBriefing,marker} from './startup-briefing.js';
import {randomUUID} from 'node:crypto';
const {LlmAdapter}=await import(process.env.DSH_E2E_LLM_MODULE);
export const name='local-dsh-schedule-gui';
export const inject=['llm','schedule','sessionController','workspaceRegistry'];
const log=(event,value)=>appendFileSync(process.env.DSH_E2E_LOG,JSON.stringify({event,value})+'\n');
const prompt='Confirm in one line that this scheduled fixture ran.';
const central=process.env.DSH_GUI_CENTRAL==='1';
const centralIDs=[];
const reuse=process.env.DSH_GUI_REUSE==='1';
let reusableTask;
class Local extends LlmAdapter {
  async listModels(provider){return (provider==='deepseek-test'?['alpha']:['beta','legacy']).map(id=>({provider,id,name:id}));}
  async resolveModel(provider,id){return (await this.listModels(provider)).some(x=>x.id===id)
    ?{provider,id,name:id,context:{contextWindow:reuse?262144:32000},reasoning:{efforts:['low','high'].map(id=>({id,name:id}))}}
    :null;}
  async *stream(options){
    const commands=[
      ...(reuse&&reusableTask?[
        [/Reuse original review|复用模型原会话/i,'schedule_admin_change_reused_model',{id:reusableTask.id,model:'alpha',thinking:'高'}],
        [/Reuse dedicated review|复用模型新会话/i,'schedule_admin_change_reused_model',{id:reusableTask.id,model:'beta',thinking:'高'}],
      ]:[]),
      ...(central?[
        [/管理台列表|Admin inventory/i,'schedule_admin_model_list',{}],
        [/管理台批量更新|Admin batch update/i,'schedule_admin_model_batch_update',{ids:centralIDs,model:'alpha',thinking:'高'}],
        [/管理台批量清除|Admin batch clear/i,'schedule_admin_model_batch_update',{ids:centralIDs,action:'clear'}],
      ]:[]),
      [/创建GUI独立任务|Create the fresh GUI task/i,'schedule_create_with_model',{title:'GUI独立任务',prompt:'Fresh GUI run only.',model:'alpha',thinking:'低',dailyTimes:['04:30','12:30','18:30'],timeZone:'Asia/Shanghai',sessionMode:'fresh_each_run'}],
      [/查询GUI独立任务|Inspect the fresh GUI task/i,'schedule_view_model',{identifier:'GUI独立任务'}],
      [/创建GUI三段任务|Create the three-time GUI task/i,'schedule_create_with_model',{title:'GUI三段任务',prompt,model:'alpha',thinking:'低',dailyTimes:['04:30','12:30','18:30'],timeZone:'Asia/Shanghai'}],
      [/把GUI旧任务改成|Change the existing GUI task/i,'schedule_update_model',{identifier:'GUI旧任务',model:'alpha',thinking:'高'}],
      [/撤销GUI旧任务|Clear the existing GUI task/i,'schedule_clear_model',{identifier:'GUI旧任务'}],
      [/查询GUI旧任务|Inspect the existing GUI task/i,'schedule_view_model',{identifier:'GUI旧任务'}],
    ];
    const textOf=m=>m?.content?.map?.(x=>x.text??'').join(' ')??'';
    const index=options.messages.findLastIndex(m=>m.role==='user'&&commands.some(([pattern])=>pattern.test(textOf(m))));
    const text=index<0?options.messages.filter(m=>m.role==='user').map(textOf).join(' '):textOf(options.messages[index]);
    const command=index<0?undefined:commands.find(([pattern])=>pattern.test(text));
    const last=index<0?undefined:options.messages.slice(index+1).findLast(m=>m.role==='tool');
    log('request',{text:text.slice(0,360),model:options.model,effort:options.reasoningEffort,briefing:options.messages.some(m=>textOf(m).includes(marker))});
    if(command&&!last){
      const [,name,args]=command;
      if(!options.tools?.some(t=>t.name===name))throw Error('Tool was not advertised: '+name);
      const id='gui_tool_'+randomUUID();const raw=JSON.stringify(args);
      log('tool',{name,args});
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:raw};
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:raw}};
      yield {type:'finish',reason:{kind:'tool-calls'}};
      return;
    }
    const payload=last?.role==='tool'?JSON.stringify(last.content):'模拟模型实际收到请求：'+options.model+'/'+(options.reasoningEffort??'默认');
    if(last?.role==='tool')log('tool-result',last.content);
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'text-delta',index:0,text:payload};
    yield {type:'block-end',index:0,block:{type:'text',text:payload}};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}
export function apply(ctx){
  installStartupBriefing(ctx,log);
  ctx.effect(()=>ctx.llm.registerAdapter(['local-test','deepseek-test'],new Local()));
  const t=setTimeout(async()=>{
    try{
      if((await ctx.schedule.list()).items.some(e=>e.title==='GUI旧任务'))return;
      const cwd=process.env.DSH_GUI_TEST_CWD;
      mkdirSync(cwd,{recursive:true});
      const workspace=await ctx.workspaceRegistry.create(cwd);
      const session=await ctx.sessionController.create({workspaceId:workspace.id,agentPreset:'schedule-alpha'});
      const task=await ctx.schedule.create({title:'GUI旧任务',prompt,
        timing:{kind:'rrule',rrule:'DTSTART;TZID=Asia/Shanghai:20261119T043000\nRRULE:FREQ=DAILY;BYHOUR=4,12,18;BYMINUTE=30'},
        target:{kind:'new',create:{cwd,agentPreset:'schedule-beta'}},
      },session.sessionId);
      log('seed',{session:session.sessionId,id:task.id});
      if(reuse){
        const receiving=await ctx.sessionController.create({workspaceId:workspace.id,agentPreset:'standard'});
        const {agent:receivingAgent}=await ctx.sessionController.resolveAgent(receiving.sessionId);
        receivingAgent.model.select({provider:'local-test',model:'beta',reasoningEffort:'low'});
        const other=await ctx.sessionController.create({workspaceId:workspace.id,agentPreset:'schedule-model-management'});
        const timing={kind:'every',every_seconds:3600};
        const target={kind:'session',sessionId:receiving.sessionId};
        reusableTask=await ctx.schedule.create({title:'共享目标任务 A',prompt,timing,target},session.sessionId);
        const sibling=await ctx.schedule.create({title:'共享目标任务 B',prompt,timing,target},session.sessionId);
        log('reuse-ready',{manager:other.sessionId,receiving:receiving.sessionId,task:reusableTask.id,sibling:sibling.id});
        const signal=new AbortController().signal;
        await ctx.sessionController.prompt({requestId:'receiving-'+randomUUID(),sessionId:receiving.sessionId,
          mode:'queue',content:[{type:'text',text:'Original receiving conversation context.'}]},signal);
        await ctx.sessionController.prompt({requestId:'reuse-admin-'+randomUUID(),sessionId:other.sessionId,
          mode:'queue',content:[{type:'text',text:'Reused receiving session GUI fixture ready.'}]},signal);
      }
      if(central){
        const otherCwd=cwd+'-other';
        mkdirSync(otherCwd,{recursive:true});
        await ctx.workspaceRegistry.create(otherCwd);
        const admin=await ctx.sessionController.create({workspaceId:workspace.id,agentPreset:'schedule-model-management'});
        for(let i=1;i<=10;i++){
          // No acting Session: represents tasks made in the native manager.
          const row=await ctx.schedule.create({title:`管理台假任务 ${i}`,prompt:'PRIVATE-QA-PROMPT',
            timing:{kind:'rrule',rrule:'DTSTART;TZID=Asia/Shanghai:20261119T043000\nRRULE:FREQ=DAILY;BYHOUR=4,12,18;BYMINUTE=30'},
            target:{kind:'new',create:{...(i<=4?{cwd}:i<=7?{cwd:otherCwd}:{}),agentPreset:'schedule-beta'}}});
          centralIDs.push(row.id);
        }
        await ctx.schedule.create({title:'管理台只读复用任务',prompt:'PRIVATE-QA-REUSED',
          timing:{kind:'after',after_seconds:3600},target:{kind:'session',sessionId:session.sessionId}});
        log('admin-ready',{session:admin.sessionId,tasks:[...centralIDs]});
        await ctx.sessionController.prompt({requestId:'admin-'+randomUUID(),sessionId:admin.sessionId,
          mode:'queue',content:[{type:'text',text:'Central schedule owner fixture ready.'}]},new AbortController().signal);
      }
      await ctx.sessionController.prompt({requestId:'seed-'+randomUUID(),sessionId:session.sessionId,
        mode:'queue',content:[{type:'text',text:'GUI QA workspace fixture ready.'}]},new AbortController().signal);
    }catch(e){log('seed-error',String(e.stack));}
  },2000);
  ctx.effect(()=>()=>clearTimeout(t));
}

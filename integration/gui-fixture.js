import {appendFileSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const {LlmAdapter}=await import(process.env.DSH_E2E_LLM_MODULE);
export const name='local-dsh-schedule-gui';
export const inject=['llm','schedule','sessionController','workspaceRegistry'];
const log=(event,value)=>appendFileSync(process.env.DSH_E2E_LOG,JSON.stringify({event,value})+'\n');
const prompt='Confirm in one line that this scheduled fixture ran.';
class Local extends LlmAdapter {
  async listModels(provider){return (provider==='deepseek-test'?['alpha']:['beta','legacy']).map(id=>({provider,id,name:id}));}
  async resolveModel(provider,id){return (await this.listModels(provider)).some(x=>x.id===id)
    ?{provider,id,name:id,context:{contextWindow:32000},reasoning:{efforts:['low','high'].map(id=>({id,name:id}))}}
    :null;}
  async *stream(options){
    const commands=[
      [/创建GUI三段任务|Create the three-time GUI task/i,'schedule_create_with_model',{title:'GUI三段任务',prompt,model:'alpha',thinking:'低',dailyTimes:['04:30','12:30','18:30'],timeZone:'Asia/Shanghai'}],
      [/把GUI旧任务改成|Change the existing GUI task/i,'schedule_update_model',{identifier:'GUI旧任务',model:'alpha',thinking:'高'}],
      [/查询GUI旧任务|Inspect the existing GUI task/i,'schedule_view_model',{identifier:'GUI旧任务'}],
    ];
    const textOf=m=>m?.content?.map?.(x=>x.text??'').join(' ')??'';
    const index=options.messages.findLastIndex(m=>m.role==='user'&&commands.some(([pattern])=>pattern.test(textOf(m))));
    const text=index<0?options.messages.filter(m=>m.role==='user').map(textOf).join(' '):textOf(options.messages[index]);
    const command=index<0?undefined:commands.find(([pattern])=>pattern.test(text));
    const last=index<0?undefined:options.messages.slice(index+1).findLast(m=>m.role==='tool');
    log('request',{text:text.slice(0,360),model:options.model,effort:options.reasoningEffort});
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
      await ctx.sessionController.prompt({requestId:'seed-'+randomUUID(),sessionId:session.sessionId,
        mode:'queue',content:[{type:'text',text:'GUI QA workspace fixture ready.'}]},new AbortController().signal);
    }catch(e){log('seed-error',String(e.stack));}
  },2000);
  ctx.effect(()=>()=>clearTimeout(t));
}

const { LlmAdapter } = await import(process.env.DSH_E2E_LLM_MODULE);
import {appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
export const name='schedule-model-e2e';
export const inject=['schedule','llm','sessionController','tools','agentPresets'];
const log=(event,value)=>appendFileSync(process.env.DSH_E2E_LOG,JSON.stringify({event,value})+'\n');
class Local extends LlmAdapter {
  async listModels(provider){return (provider==='deepseek-test'?['alpha']:['beta','legacy']).map(id=>({provider,id,name:id}));}
  async resolveModel(provider,id){
    if (!['alpha','beta','legacy'].includes(id)) throw new Error('fixture: unsupported test model');
    return {provider,id,name:id,context:{contextWindow:32000},reasoning:{efforts:['high','low'].map(id=>({id,name:id}))}};
  }
  async *stream(options) {
    log('request',{provider:options.provider,model:options.model,effort:options.reasoningEffort,purpose:options.purpose});
    const text=options.messages.flatMap(m=>m.role==='user'&&Array.isArray(m.content)?m.content.map(x=>x.text??''):[]).join(' ');
    if(text.includes('用ds+思考低的模型')&&!options.messages.some(m=>m.role==='tool')){
      if(!options.tools?.some(t=>t.name==='schedule_create_with_model')) throw new Error('Tool not advertised');
      const id='test_tool_'+randomUUID();
      const name='schedule_create_with_model';
      const args=JSON.stringify({title:'alpha',prompt:'Reply with fixture-ok only.',model:'ds',thinking:'低',intervalMinutes:60});
      log('mock_tool_call',{name});
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:args};
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:args}};
      yield {type:'finish',reason:{kind:'tool-calls'}};
      return;
    }
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'text-delta',index:0,text:'fixture-ok'};
    yield {type:'block-end',index:0,block:{type:'text',text:'fixture-ok'}};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}
export function apply(ctx) {
  ctx.effect(()=>ctx.llm.registerAdapter(['local-test','deepseek-test'],new Local()), 'fixture-adapter');
  const timer=setTimeout(async()=>{
    try {
      if (process.env.DSH_E2E_RESTART === '1') {
        const rows = (await ctx.schedule.list()).items;
        log('restart',rows.map(e=>[e.title,e.target.create?.agentPreset,!!e.lastDelivery]));
        const alpha=rows.find(row=>row.title==='alpha');
        const {agent}=await ctx.sessionController.resolveAgent(alpha.involvedSessionIds.find(id=>id!==alpha.target.sessionId));
        const q=ctx.tools.get('schedule_view_model');
        const result=JSON.parse(await q.execute({identifier:alpha.id},{agent,signal:new AbortController().signal}));
        log('query_restart',result);
        return;
      }
      const creator = ctx.tools.get('schedule_create_with_model');
      if (!creator) throw new Error('creator tool failed to register');
      const rejectArgs={title:'nested must not write',prompt:'not allowed',model:'ds',thinking:'低',intervalMinutes:60};
      try {
        await creator.execute(rejectArgs,{agent:{options:{subagentDepth:1},session:{header:{},id:'not-real'}}});
        throw new Error('Nested scheduled mutation unexpectedly accepted');
      } catch(error) {
        if(!String(error.message).includes('root session'))throw error;
        log('nested_rejected',true);
      }
      const {sessionId} = await ctx.sessionController.create({});
      const {agent} = await ctx.sessionController.resolveAgent(sessionId);
      const signal=new AbortController().signal;
      await ctx.sessionController.prompt({
        requestId:'test-'+randomUUID(),sessionId,mode:'queue',
        content:[{type:'text',text:'用ds+思考低的模型，跑进度检查定时任务，每小时检查一次。'}],
      },signal);
      let created;
      for(let i=0;i<24;i++){
        const candidate=(await ctx.schedule.list()).items.find(
          x=>x.title==='alpha'&&x.involvedSessionIds.includes(sessionId));
        if(candidate){created={id:candidate.id};break;}
        await new Promise(r=>setTimeout(r,200));
      }
      if(!created) throw new Error('Mock natural prompt did not create a task through the Agent tool');
      log('creator',created);
      const query=ctx.tools.get('schedule_view_model');
      const exec={agent,signal:new AbortController().signal};
      const before=JSON.parse(await query.execute({identifier:'alpha'},exec));
      log('query_before',before);
      const inputs=[['beta','schedule-beta'],['broken','schedule-broken'],['legacy',undefined]];
      const tasks=await Promise.all(inputs.map(([title,agentPreset])=>ctx.schedule.create({
        title,prompt:'Reply with fixture-ok only.',timing:{kind:'after',after_seconds:3600},
        target:{kind:'new',create:agentPreset?{agentPreset}:{}}
      })));
      tasks.unshift(await ctx.schedule.view({id:created.id}));
      log('stored',tasks.map(e=>[e.title,e.target.create?.agentPreset]));
      await Promise.all(tasks.map(async e=>{
        try {const row=await ctx.schedule.run({id:e.id});log('run',[e.title,!!row.lastDelivery,row.code]);}
        catch(error){log('run-error',[e.title,error.message]);}
      }));
      for(let i=0;i<14;i++){
        await new Promise(resolve=>setTimeout(resolve,200));
        const answer=JSON.parse(await query.execute({identifier:created.id},exec));
        if(answer.latestRun.requested || i===13) {log('query_after',answer);break;}
      }
      const hidden=JSON.parse(await query.execute({identifier:'legacy'},exec));
      log('query_hidden',hidden);
    } catch(error){log('error',error.stack);}
  },1800);
  ctx.effect(()=>()=>clearTimeout(timer),'fixture-timer');
}

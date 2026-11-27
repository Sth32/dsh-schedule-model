import { verifyUpgrade, seedUpgrade, upgradePrefix } from './upgrade-fixture.js';
import {installStartupBriefing,marker} from './startup-briefing.js';
import {verifyOverrides} from './override-fixture.js';
const { LlmAdapter } = await import(process.env.DSH_E2E_LLM_MODULE);
import {appendFileSync,mkdirSync,realpathSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export const name='schedule-model-e2e';
export const inject=['schedule','llm','sessionController','tools','agentPresets','workspaceRegistry','storageDomain'];
const log=(event,value)=>appendFileSync(process.env.DSH_E2E_LOG,JSON.stringify({event,value})+'\n');
class Local extends LlmAdapter {
  async listModels(provider){return (provider==='deepseek-test'?['alpha']:['beta','legacy']).map(id=>({provider,id,name:id}));}
  async resolveModel(provider,id){
    if (!['alpha','beta','legacy'].includes(id)) throw new Error('fixture: unsupported test model');
    return {provider,id,name:id,context:{contextWindow:32000},reasoning:{efforts:['high','low'].map(id=>({id,name:id}))}};
  }
  async *stream(options) {
    const text=options.messages.flatMap(m=>m.role==='user'&&Array.isArray(m.content)?m.content.map(x=>x.text??''):[]).join(' ');
    if(text.includes(marker)&&text.includes('fixture-briefing-override'))
      log('startup_briefing_request',{provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort});
    if(text.includes('fixture-must-not-fallback')||text.includes('fixture-fresh-mode'))
      log('fresh_mock_request',{text,provider:options.provider,model:options.model,effort:options.reasoningEffort});
    log('request',{provider:options.provider,model:options.model,effort:options.reasoningEffort,purpose:options.purpose});
    for(const stage of ['upgrade','restart']){
      if(text.includes('fixture-upgrade-probe-'+stage))
        log('upgrade_mock_request',{stage,provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort});
    }
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
  installStartupBriefing(ctx,log);
  ctx.effect(()=>ctx.llm.registerAdapter(['local-test','deepseek-test'],new Local()), 'fixture-adapter');
  const timer=setTimeout(async()=>{
    try {
      if(process.env.DSH_E2E_REMOVAL_PROBE==='seed'){
        const {sessionId}=await ctx.sessionController.create({});
        const {agent}=await ctx.sessionController.resolveAgent(sessionId);
        const row=await ctx.schedule.create({title:'Removal route-loss probe',prompt:'Reply with fixture-ok only.',
          timing:{kind:'every',every_seconds:3600},target:{kind:'new',create:{}}},sessionId);
        const update=ctx.tools.get('schedule_update_model');
        const configured=JSON.parse(await update.execute({identifier:row.id,model:'ds',thinking:'低'},{agent}));
        if(configured.configured?.model!=='alpha')throw new Error('Probe did not commit an override');
        log('removal_probe_seed',row.id);
        return;
      }
      if(process.env.DSH_E2E_REMOVAL_PROBE==='verify'){
        if(ctx.tools.get('schedule_update_model'))throw new Error('Plugin was not removed');
        const prior=(await ctx.schedule.list()).items.find(x=>x.title==='Removal route-loss probe');
        if(!prior)throw new Error('Native task missing when plugin is absent');
        const delivered=await ctx.schedule.run({id:prior.id});
        if(!delivered.lastDelivery)throw new Error('Native task did not deliver after uninstall');
        const {agent}=await ctx.sessionController.resolveAgent(delivered.lastDelivery.targetSessionId);
        log('removal_probe_actual',{id:prior.id,route:agent.model.current()});
        return;
      }
      if(process.env.DSH_E2E_UPGRADE_SEED==='1'){
        await seedUpgrade(ctx,log);
        return;
      }
      if(process.env.DSH_E2E_UPGRADE_FROM)
        await verifyUpgrade(ctx,log,process.env.DSH_E2E_RESTART==='1');
      if (process.env.DSH_E2E_RESTART === '1') {
        const rows = (await ctx.schedule.list()).items;
        const fresh=rows.find(row=>row.title==='Fresh task mode');
        if(fresh){
          const {agent}=await ctx.sessionController.resolveAgent(fresh.involvedSessionIds[0]);
          const result=JSON.parse(await ctx.tools.get('schedule_view_model').execute({identifier:fresh.id},{agent,signal:new AbortController().signal}));
          log('fresh_restart',{status:fresh.status,configured:result.configured,receipt:!!fresh.lastDelivery,observed:result.latestRun});
        }
        log('restart',rows.filter(e=>!e.title.startsWith(upgradePrefix)&&e.title!=='Fresh task mode').map(e=>[e.title,e.target.create?.agentPreset,!!e.lastDelivery]));
        const multi=rows.find(row=>row.title==='multi');
        const {agent:multiAgent}=await ctx.sessionController.resolveAgent(multi.target.sessionId);
        const pinned=ctx.get('sessionTitle').get(multiAgent.session);
        log('multi_title_restart',[pinned?.title,pinned?.source?.kind]);
        log('multi_restart',{preset:multiAgent.session.header.agentPreset,
          current:multiAgent.model.current(),cwd:multiAgent.session.header.cwd.endsWith('test-schedule-workspace')});
        const alpha=rows.find(row=>row.title==='alpha');
        const {agent}=await ctx.sessionController.resolveAgent(alpha.involvedSessionIds.find(id=>id!==alpha.target.sessionId));
        const q=ctx.tools.get('schedule_view_model');
        const result=JSON.parse(await q.execute({identifier:alpha.id},{agent,signal:new AbortController().signal}));
        log('query_restart',result);
        await verifyOverrides(ctx,log,true);
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
      const cwd=join(process.env.DSH_HOME,'test-schedule-workspace');
      mkdirSync(cwd,{recursive:true});
      const workspace=await ctx.workspaceRegistry.create(cwd);
      const presetSource=await ctx.sessionController.create({agentPreset:'schedule-alpha'});
      const {agent:presetAgent}=await ctx.sessionController.resolveAgent(presetSource.sessionId);
      const blockedPrompt='fixture-must-not-fallback';
      const nativeStaging=await ctx.schedule.create({title:'Guard staging test',prompt:blockedPrompt,
        timing:{kind:'every',every_seconds:3600},target:{kind:'new',create:{cwd,
          agentPreset:'dsh-schedule-model/setup/fixture-missing'}}},presetSource.sessionId);
      try {
        await ctx.schedule.run({id:nativeStaging.id});
        throw Error('Staging guard did not block native Run now');
      }catch(error){
        if(!/Unknown agent preset/.test(error.message))throw error;
        log('fresh_native_staging_blocked',true);
      }
      await ctx.schedule.edit({id:nativeStaging.id,action:'delete'},presetSource.sessionId);
      const beforeFailed=(await ctx.schedule.list()).total;
      const failurePath=join(process.env.DSH_HOME,'profiles','web','schedule-model-overrides');
      writeFileSync(failurePath,'force model store failure',{flag:'wx'});
      try{
        await creator.execute({title:'Must not arm',prompt:blockedPrompt,model:'ds',thinking:'低',intervalMinutes:60,
          sessionMode:'fresh_each_run',cwd},{agent:presetAgent,signal});
        throw Error('Storage failure unexpectedly allowed');
      }catch(error){
        if(!/EEXIST/.test(error.message))throw error;
      }finally{unlinkSync(failurePath);}
      log('fresh_failed_creation_cleaned',beforeFailed===(await ctx.schedule.list()).total);
      const linkedBefore=workspace.sessionIds.length;
      const fresh=JSON.parse(await creator.execute({title:'Fresh task mode',sessionTitle:'Pinned fresh title',
        prompt:'fixture-fresh-mode',model:'ds',thinking:'低',sessionMode:'fresh_each_run',
        dailyTimes:['04:30','12:30','18:30'],timeZone:'Asia/Singapore',cwd},{agent:presetAgent,signal}));
      const freshRow=await ctx.schedule.view({id:fresh.id});
      log('fresh_created',{newTarget:freshRow.target.kind==='new',noSession:workspace.sessionIds.length===linkedBefore,
        unchangedPreset:freshRow.target.create.agentPreset==='schedule-alpha',cwd:freshRow.target.create.cwd===realpathSync(cwd),
        recurrence:/BYHOUR=4,12,18/.test(freshRow.rrule)});
      const runFresh=async()=>{
        const result=await ctx.schedule.run({id:fresh.id});
        const runId=result.lastDelivery?.targetSessionId;
        if(!runId)throw Error('Fresh delivery did not produce a receipt');
        const {agent:run}=await ctx.sessionController.resolveAgent(runId);
        const pinned=ctx.get('sessionTitle').get(run.session);
        log('fresh_run',{id:runId,title:pinned?.title,linked:workspace.sessionIds.includes(runId),route:run.model.current()});
        for(let i=0;i<60&&run.status!=='idle';i++)await new Promise(r=>setTimeout(r,50));
        return runId;
      };
      const first=await runFresh();
      await ctx.workspaceRegistry.archiveSession(first,{stopActivity:true});
      log('fresh_archive_kept_active',(await ctx.schedule.view({id:fresh.id})).status==='active');
      if(process.env.DSH_E2E_FRESH_LONG==='1'){
        setTimeout(()=>runFresh().then(second=>log('fresh_distinct',second!==first)).catch(error=>log('error',error.stack)),61_000);
      }
      const multiInput={title:'multi',sessionTitle:'Dedicated dispatch',prompt:'Reply with fixture-ok only.',model:'ds',thinking:'低',
        dailyTimes:['08:00','17:30'],timeZone:'Asia/Singapore',cwd};
      const countBefore=(await ctx.schedule.list()).total;
      try{
        await creator.execute({...multiInput,cwd:join(cwd,'missing')},{agent:presetAgent,signal});
        throw new Error('Missing working directory unexpectedly allowed');
      }catch(error){if(!String(error.message).includes('does not exist'))throw error;}
      log('invalid_cwd_unchanged',countBefore===(await ctx.schedule.list()).total);
      const multi=JSON.parse(await creator.execute(multiInput,{agent:presetAgent,signal}));
      const task=await ctx.schedule.view({id:multi.id});
      const {agent:dedicated}=await ctx.sessionController.resolveAgent(task.target.sessionId);
      const pinned=ctx.get('sessionTitle').get(dedicated.session);
      log('multi_title_before_delivery',[pinned?.title,pinned?.source?.kind]);
      log('multi_location',{
        correctCwd:dedicated.session.header.cwd===realpathSync(cwd),
        sameWorkspace:workspace.sessionIds.includes(task.target.sessionId),
        preset:dedicated.session.header.agentPreset,
      });
      log('multi_rrule',task.rrule);
      const legacyCreator=ctx.tools.get('schedule_create_with_preset');
      const {sessionId:sourceId}=await ctx.sessionController.create({workspaceId:workspace.id});
      const {agent:sourceAgent}=await ctx.sessionController.resolveAgent(sourceId);
      const basePreset={prompt:'Reply with fixture-ok only.',preset:'schedule-beta',
        rrule:'DTSTART:20000115T120000Z\nRRULE:FREQ=DAILY'};
      const inherited=JSON.parse(await legacyCreator.execute({...basePreset,title:'legacy-inherited'},
        {agent:sourceAgent,signal}));
      const explicit=JSON.parse(await legacyCreator.execute({...basePreset,title:'legacy-explicit',cwd},
        {agent:presetAgent,signal}));
      const legacyCreated=await Promise.all([inherited,explicit].map(({id})=>ctx.schedule.view({id})));
      log('legacy_workdir',legacyCreated.map(x=>x.target.create.cwd===realpathSync(cwd)));
      const legacyDelivered=await ctx.schedule.run({id:inherited.id});
      const legacySession=legacyDelivered.lastDelivery?.targetSessionId;
      if(!legacySession)throw new Error('Legacy preset run did not deliver');
      const {agent:legacyAgent}=await ctx.sessionController.resolveAgent(legacySession);
      log('legacy_delivery_workdir',legacyAgent.session.header.cwd===realpathSync(cwd));
      const inputs=[['beta','schedule-beta'],['broken','schedule-broken'],['legacy',undefined]];
      const tasks=await Promise.all(inputs.map(([title,agentPreset])=>ctx.schedule.create({
        title,prompt:'Reply with fixture-ok only.',timing:{kind:'after',after_seconds:3600},
        target:{kind:'new',create:agentPreset?{agentPreset}:{}}
      })));
      tasks.unshift(await ctx.schedule.view({id:created.id}),task);
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
      await verifyOverrides(ctx,log);
    } catch(error){log('error',error.stack);}
  },1800);
  ctx.effect(()=>()=>clearTimeout(timer),'fixture-timer');
}

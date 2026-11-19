// Isolated fixture for plugins that splice a briefing in agent/created.
// No third-party plugin, real conversation, or external model is needed.
const {createUserMessage}=await import(process.env.DSH_E2E_LLM_MODULE);
export const marker='Fixture startup briefing from a session plugin.';
export function installStartupBriefing(ctx,log) {
  ctx.on('agent/created',({agent})=>{
    if(agent.session.header.agentPreset!=='schedule-beta')return;
    agent.inbox.splice('next-step',agent.inbox.nextStep.length,0,[
      createUserMessage({content:[{type:'text',text:marker}],
        source:{kind:'fixture-startup-briefing',form:'instructions'}}),
    ]);
    log('startup_briefing',{session:agent.session.id,count:agent.inbox.nextStep.length});
  });
}

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const upgradePrefix='Upgrade-retained task';
const expected={provider:'deepseek-test',model:'alpha',reasoningEffort:'low'};
const stages=['upgrade','restart'];
const title=stage=>`${upgradePrefix} (${stage})`;

export async function seedUpgrade(ctx,log){
  const version=process.env.DSH_E2E_UPGRADE_SEED_VERSION;
  const editor=ctx.tools.get('schedule_update_model');
  if(version==='0.1.4')assert.equal(editor,undefined,'v0.1.4 is the native-only baseline');
  if(version==='0.1.5')assert.ok(editor,'v0.1.5 must seed a pre-existing override');
  const cwd=join(process.env.DSH_HOME,'upgrade-workspace');
  mkdirSync(cwd,{recursive:true});
  const {sessionId}=await ctx.sessionController.create({cwd});
  const {agent}=await ctx.sessionController.resolveAgent(sessionId);
  const exec={agent,signal:new AbortController().signal};
  const rows=[];
  let alreadyReserved;
  for(const stage of (editor?stages:[null])){
    const row=await ctx.schedule.create({
      title:stage===null?upgradePrefix:title(stage),
      prompt:stage===null?'Fixture state retained':`Reply with fixture-upgrade-probe-${stage} only.`,
      timing:{kind:'every',every_seconds:3600},
      target:{kind:'new',create:{cwd,agentPreset:'schedule-beta'}},
    },sessionId);
    if(editor){
      const result=JSON.parse(await editor.execute({identifier:row.id,model:'ds',thinking:'低'},exec));
      assert.deepEqual(result.configured,expected);
      assert.deepEqual(await ctx.schedule.view({id:row.id}),row,
        'seeding the route must not modify the native task');
    }
    if(version==='0.1.5'&&stage==='upgrade'){
      await assert.rejects(ctx.schedule.run({id:row.id}),
        /Cannot change a scheduled model after the reserved Session has started or received input/);
      const persisted=ctx.storageDomain.get('schedule').table('tasks').get(row.id);
      alreadyReserved=persisted?.pendingDelivery?.targetSessionId;
      assert.ok(alreadyReserved,'v0.1.5 really stored a stuck reservation');
      assert.equal((await ctx.schedule.view({id:row.id})).lastDelivery,undefined);
    }
    rows.push(row);
  }
  log('upgrade_seed',{mode:editor?'existing-override':'native-only',rows,alreadyReserved});
}

export async function verifyUpgrade(ctx,log,restart){
  const rows=(await ctx.schedule.list()).items;
  const baseline=rows.find(row=>row.title===upgradePrefix);
  const event=restart?'upgrade_restart':'upgrade_retained';
  if(baseline){
    log(event,baseline);
    return;
  }
  const stage=restart?'restart':'upgrade';
  const row=rows.find(row=>row.title===title(stage));
  assert.ok(row,`must retain the seeded native task for ${stage}`);
  assert.equal(row.lastDelivery,undefined,'only use its first fresh delivery');
  log(event,row);
  const {agent}=await ctx.sessionController.resolveAgent(row.involvedSessionIds[0]);
  const exec={agent,signal:new AbortController().signal};
  const query=ctx.tools.get('schedule_view_model');
  const peek=async()=>JSON.parse(await query.execute({identifier:row.id},exec));
  const prior=await peek();
  assert.deepEqual(prior.configured,expected);
  if(process.env.DSH_E2E_UPGRADE_SEED_VERSION==='0.1.5'&&!restart){
    assert.equal(prior.pending?.status,'reserved');
    assert.equal(prior.latestRun.status,'pending_delivery');
    assert.equal(prior.latestRun.requested,null);
  }
  const delivered=await ctx.schedule.run({id:row.id});
  assert.ok(delivered.lastDelivery,'the native scheduler acknowledged a fresh delivery');
  const {agent:receiver}=await ctx.sessionController.resolveAgent(delivered.lastDelivery.targetSessionId);
  assert.equal(ctx.agentPresets.presetForSession(receiver.session),row.target.create.agentPreset);
  assert.equal(receiver.session.header.cwd,row.target.create.cwd);
  let observed;
  for(let i=0;i<30;i++){
    observed=(await peek()).latestRun.requested;
    if(observed)break;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.deepEqual(observed,expected);
  assert.equal((await peek()).pending,null);
  log('upgrade_delivered',{stage,taskId:row.id,recipient:delivered.lastDelivery.targetSessionId,observed});
}

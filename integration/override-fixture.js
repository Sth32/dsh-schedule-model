import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const title='Existing PTC-like recurring override';
const unaffectedTitle='Other task, same preset';
const timedTitle='Native timer override';
const schedulePrompt='Reply with fixture-ok only.';
const rrule='DTSTART;TZID=Asia/Shanghai:20261119T043000\nRRULE:FREQ=DAILY;BYHOUR=4,12,18;BYMINUTE=30';

export async function verifyOverrides(ctx,log,restart=false) {
  if(restart){
    const tasks=(await ctx.schedule.list()).items;
    const task=tasks.find(row=>row.title===title);
    assert.ok(task?.lastDelivery,'original edited task/history present after restart');
    const {agent}=await ctx.sessionController.resolveAgent(task.involvedSessionIds[0]);
    const q=ctx.tools.get('schedule_view_model');
    const result=JSON.parse(await q.execute({identifier:task.id},{agent,signal:new AbortController().signal}));
    assert.deepEqual(result.configured,{provider:'deepseek-test',model:'alpha',reasoningEffort:'high'});
    assert.equal(result.latestRun.requested?.model,'alpha');
    assert.equal(task.target.kind,'new');
    assert.equal(task.target.create.agentPreset,'schedule-beta');
    assert.equal(task.rrule,rrule);
    log('override_restart_ok',true);
    return;
  }
  const cwd=join(tmpdir(),'dsh-override-sample-workspace');
  mkdirSync(cwd,{recursive:true});
  const {sessionId}=await ctx.sessionController.create({cwd});
  const {agent}=await ctx.sessionController.resolveAgent(sessionId);
  const exec={agent,signal:new AbortController().signal};
  const edit=ctx.tools.get('schedule_update_model');
  const q=ctx.tools.get('schedule_view_model');
  assert.ok(edit,'schedule_update_model must be available');
  const create=(title,timing,target,actor=sessionId)=>ctx.schedule.create(
    {title,prompt:schedulePrompt,timing,target},actor);
  const kind='new',target={kind,create:{cwd,agentPreset:'schedule-beta'}};
  const timing={kind:'rrule',rrule};
  const [before, unaffected, shared]=await Promise.all([
    create(title,timing,target),
    create(unaffectedTitle,timing,target),
    create('Refuse a shared destination',{kind:'after',after_seconds:3600},{kind:'session',sessionId}),
  ]);
  const call=identifier=>edit.execute({identifier,model:'alpha',thinking:'high'},exec);
  assert.equal(JSON.parse(await call(shared.id)).code,'requires_fresh_session_target');
  const foreignSession=(await ctx.sessionController.create({})).sessionId;
  const {agent:foreign}=await ctx.sessionController.resolveAgent(foreignSession);
  assert.equal(JSON.parse(await edit.execute({identifier:before.id,model:'alpha',thinking:'high'},{...exec,agent:foreign})).code,'not_found_in_session');
  await call(before.id);
  const after=await ctx.schedule.view({id:before.id});
  assert.deepEqual(after,before,'existing task record, target, cwd, preset, RRULE, next and history are not edited');
  const peek=(id)=>q.execute({identifier:id},exec).then(JSON.parse);
  assert.deepEqual((await peek(before.id)).configured,{provider:'deepseek-test',model:'alpha',reasoningEffort:'high'});
  assert.deepEqual((await peek(unaffected.id)).configured,{provider:'local-test',model:'beta',reasoningEffort:'low'});
  assert.equal((await peek(shared.id)).configured,null);
  const row=await ctx.schedule.run({id:before.id});
  assert.ok(row.lastDelivery);
  const other=await ctx.schedule.run({id:unaffected.id});
  assert.ok(other.lastDelivery);
  assert.notEqual(row.lastDelivery.targetSessionId,other.lastDelivery.targetSessionId);
  const {agent:recipient}=await ctx.sessionController.resolveAgent(row.lastDelivery.targetSessionId);
  assert.equal(ctx.agentPresets.presetForSession(recipient.session),'schedule-beta');
  assert.equal(recipient.session.header.cwd,cwd);
  const timed=await create(timedTitle,{kind:'after',after_seconds:3},target);
  await call(timed.id);
  let seen, otherSeen, timedSeen;
  for(let i=0;i<38;i++){
    await new Promise(r=>setTimeout(r,150));
    [seen,otherSeen,timedSeen]=await Promise.all([peek(before.id),peek(unaffected.id),peek(timed.id)]);
    if(seen.latestRun.requested && otherSeen.latestRun.requested && timedSeen.latestRun.requested)break;
  }
  assert.deepEqual(seen.latestRun.requested,{provider:'deepseek-test',model:'alpha',reasoningEffort:'high'});
  assert.deepEqual(otherSeen.latestRun.requested,{provider:'local-test',model:'beta',reasoningEffort:'low'});
  assert.deepEqual(timedSeen.latestRun.requested,{provider:'deepseek-test',model:'alpha',reasoningEffort:'high'});
  log('override_manual_timer_cwd_preset_ok',true);
}

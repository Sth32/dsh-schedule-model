import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const events=readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse);
const by=name=>events.filter(e=>e.event===name).map(e=>e.value);
assert.deepEqual(by('error'),[]);
assert.equal(by('creator').length,1);
assert.deepEqual(by('nested_rejected'),[true]);
assert.equal(by('mock_tool_call').length,1);
const routes=[...new Set(by('request').map(x=>[x.model,x.effort].join(':')))].sort();
assert.deepEqual(routes,['alpha:high','alpha:low','beta:low','legacy:']);
assert.ok(by('request').every(x=>['local-test','deepseek-test'].includes(x.provider)));
assert.deepEqual(by('run').map(([title,delivered])=>[title,delivered]).sort(),
  [['alpha',true],['beta',true],['legacy',true],['multi',true]]);
assert.match(by('run-error').find(([t])=>t==='broken')[1],/no adapter registered/);
assert.deepEqual(by('restart').flat().filter(([title])=>!['Existing PTC-like recurring override','Other task, same preset','Native timer override','Refuse a shared destination','Clear a stored override'].includes(title)).sort(),[
  ['alpha',null,true],['beta','schedule-beta',true],
  ['broken','schedule-broken',false],['legacy',null,true],
  ['legacy-explicit','schedule-beta',false],['legacy-inherited','schedule-beta',true],['multi',null,true]
]);


assert.deepEqual(by('query_before')[0].configured,{provider:'deepseek-test',model:'alpha',reasoningEffort:'low'});
assert.equal(by('query_before')[0].latestRun.status,'no_recorded_delivery');
assert.deepEqual(by('query_after')[0].latestRun.requested,{provider:'deepseek-test',model:'alpha',reasoningEffort:'low'});
assert.equal(by('query_after')[0].latestRun.providerReturnedModel,null);
assert.equal(by('query_hidden')[0].code,'not_found_in_session');

assert.deepEqual(by('query_restart')[0].configured,{provider:'deepseek-test',model:'alpha',reasoningEffort:'low'});
assert.deepEqual(by('query_restart')[0].latestRun.requested,{provider:'deepseek-test',model:'alpha',reasoningEffort:'low'});

assert.deepEqual(by('invalid_cwd_unchanged'),[true]);
assert.deepEqual(by('multi_location'),[{correctCwd:true,sameWorkspace:true,preset:'schedule-alpha'}]);
assert.match(by('multi_rrule')[0], /BYSETPOS=1,4/);
assert.deepEqual(by('multi_restart'),[{preset:'schedule-alpha',
 current:{provider:'deepseek-test',model:'alpha',reasoningEffort:'low'},cwd:true}]);

assert.deepEqual(by('legacy_workdir'),[[true,true]]);
assert.deepEqual(by('legacy_delivery_workdir'),[true]);
console.log('PASS: clean install, natural chat, native schedule, cwd/preset delivery and restart');

assert.deepEqual(by('override_manual_timer_cwd_preset_ok'), [true]);
assert.deepEqual(by('override_restart_ok'), [true]);
assert.deepEqual(by('override_clear_preserves_task_ok'), [true]);
assert.ok(by('startup_briefing').some(({count})=>count>0));
assert.deepEqual(by('startup_briefing_request'), [
  {provider:'deepseek-test',model:'alpha',reasoningEffort:'high'},
]);
console.log('PASS: native timer received startup next-step briefing and dispatched with the different requested route');

if(process.env.DSH_E2E_UPGRADE_FROM){
 assert.equal(by('upgrade_seed').length,1);
 const seed=by('upgrade_seed')[0];
 if(seed.mode==='native-only'){
   assert.deepEqual(by('upgrade_retained'),seed.rows);
   assert.deepEqual(by('upgrade_restart'),seed.rows);
   assert.deepEqual(by('upgrade_delivered'),[]);
   assert.deepEqual(by('upgrade_mock_request'),[]);
   console.log('PASS: native-only seed task unchanged after upgrade and cold restart');
 }else{
   assert.equal(seed.mode,'existing-override');
   assert.equal(seed.rows.length,2);
   assert.deepEqual(by('upgrade_retained'),[seed.rows[0]]);
   assert.deepEqual(by('upgrade_restart'),[seed.rows[1]]);
   const routed={provider:'deepseek-test',model:'alpha',reasoningEffort:'low'};
   const deliveries=by('upgrade_delivered');
   assert.deepEqual(deliveries.map(({stage,taskId,observed})=>[stage,taskId,observed]),
    [['upgrade',seed.rows[0].id,routed],['restart',seed.rows[1].id,routed]]);
   assert.notEqual(deliveries[0].recipient,deliveries[1].recipient);
   if(seed.alreadyReserved){
     assert.equal(deliveries[0].recipient,seed.alreadyReserved);
     console.log('PASS: upgrade recovered a genuinely wedged v0.1.5 reservation without recreating the task or the session');
   }
   assert.deepEqual(by('upgrade_mock_request'),['upgrade','restart'].map(stage=>({stage,...routed})));
   console.log('PASS: existing overrides retained across upgrade and cold restart; two actual mock-provider requests match');
 }
}
if(process.env.DSH_E2E_LONG_HISTORY==='1'){
 assert.deepEqual(by('native_repeat_history_ok'),[true]);
 assert.deepEqual(by('native_repeat_restart_ok'),[true]);
 console.log('PASS: actual repeated delivery honors cadence floor, keeps both receipts, pages by cursor and persists old route');
}

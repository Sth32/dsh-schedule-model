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
assert.deepEqual(by('restart').flat().filter(([title])=>!['Existing PTC-like recurring override','Other task, same preset','Native timer override','Refuse a shared destination'].includes(title)).sort(),[
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

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const events=readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse);
const by=name=>events.filter(e=>e.event===name).map(e=>e.value);
assert.deepEqual(by('error'),[]);
assert.equal(by('creator').length,1);
assert.equal(by('mock_tool_call').length,1);
const routes=[...new Set(by('request').map(x=>[x.model,x.effort].join(':')))].sort();
assert.deepEqual(routes,['alpha:low','beta:low','legacy:']);
assert.ok(by('request').every(x=>['local-test','deepseek-test'].includes(x.provider)));
assert.deepEqual(by('run').map(([title,delivered])=>[title,delivered]).sort(),
  [['alpha',true],['beta',true],['legacy',true]]);
assert.match(by('run-error').find(([t])=>t==='broken')[1],/no adapter registered/);
assert.deepEqual(by('restart').flat().sort(),[
  ['alpha',null,true],['beta','schedule-beta',true],
  ['broken','schedule-broken',false],['legacy',null,true]
]);


assert.deepEqual(by('query_before')[0].configured,{provider:'deepseek-test',model:'alpha',reasoningEffort:'low'});
assert.equal(by('query_before')[0].latestRun.status,'no_recorded_delivery');
assert.deepEqual(by('query_after')[0].latestRun.requested,{provider:'deepseek-test',model:'alpha',reasoningEffort:'low'});
assert.equal(by('query_after')[0].latestRun.providerReturnedModel,null);
assert.equal(by('query_hidden')[0].code,'not_found_in_session');

assert.deepEqual(by('query_restart')[0].configured,{provider:'deepseek-test',model:'alpha',reasoningEffort:'low'});
assert.deepEqual(by('query_restart')[0].latestRun.requested,{provider:'deepseek-test',model:'alpha',reasoningEffort:'low'});
console.log('PASS: clean install, natural chat and tool call, real schedule, scoped request and restart checks');

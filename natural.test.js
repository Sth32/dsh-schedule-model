import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveNatural,naturalTiming} from './natural.js';
const reasoning={efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]};
const ds=(models)=>({groups:[{id:'deepseek-official',models}]});
const alpha={id:'deepseek-alpha',name:'Alpha',reasoning};
const beta={id:'deepseek-beta',name:'Beta',reasoning};
test('unique ds and Chinese low resolve only to exact supported route',()=>{
 assert.deepEqual(resolveNatural(ds([alpha]),'DS','低').selection,
  {provider:'deepseek-official',model:'deepseek-alpha',reasoningEffort:'low'});
 assert.deepEqual(resolveNatural(ds([alpha,beta]),'deepseek-official/deepseek-beta').selection,
  {provider:'deepseek-official',model:'deepseek-beta'});
});
test('ambiguous model and unsupported thinking never choose a fallback',()=>{
 assert.equal(resolveNatural(ds([alpha,beta]),'ds','低').code,'ambiguous_model');
 assert.equal(resolveNatural(ds([alpha]),'ds','极高').code,'unsupported_or_ambiguous_thinking');
 assert.equal(resolveNatural(ds([alpha]),'foo','低').code,'unknown_model');
 assert.equal(resolveNatural(ds([{...alpha,reasoning:null}]),'ds','低').code,'unsupported_or_ambiguous_thinking');
});
test('hourly scheduling is native every, no RRULE involved',()=>{
 assert.deepEqual(naturalTiming({intervalMinutes:60}),{kind:'every',every_seconds:3600});
 assert.throws(()=>naturalTiming({intervalMinutes:60,at:'2026-11-20T12:00:00Z'}),/exactly one/);
 assert.throws(()=>naturalTiming({at:'2026-11-20T12:00:00'}),/UTC offset/);
});

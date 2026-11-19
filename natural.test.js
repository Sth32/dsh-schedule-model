import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveNatural,naturalTiming,validateNaturalRoute} from './natural.js';
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
test('multiple daily times use one native rule with exact wall-clock pairs',()=>{
 assert.deepEqual(naturalTiming({dailyTimes:['17:30','08:00'],timeZone:'Asia/Singapore'}),
   {kind:'rrule',rrule:'DTSTART;TZID=Asia/Singapore:20000115T120000\nRRULE:FREQ=DAILY;BYHOUR=8,17;BYMINUTE=0,30;BYSECOND=0;BYSETPOS=1,4'});
 assert.doesNotMatch(naturalTiming({dailyTimes:['08:00','17:00'],timeZone:'UTC'}).rrule,/BYSETPOS/);
 assert.throws(()=>naturalTiming({dailyTimes:['08:00','08:00'],timeZone:'UTC'}),/duplicates/);
 assert.throws(()=>naturalTiming({dailyTimes:['08:00','8:30'],timeZone:'UTC'}),/HH:mm/);
 assert.throws(()=>naturalTiming({dailyTimes:['08:00','08:30'],timeZone:'Asia/NotReal'}),/Unknown time zone/);
 assert.throws(()=>naturalTiming({dailyTimes:['08:00','08:30'],timeZone:'UTC\nRRULE:evil'}),/IANA/);
 assert.throws(()=>naturalTiming({dailyTime:'08:00:00',dailyTimes:['08:00','08:30'],timeZone:'UTC'}),/exactly one/);
 assert.throws(()=>naturalTiming({
  dailyTimes:Array.from({length:20},(_,i)=>`${String(i).padStart(2,'0')}:${String(i).padStart(2,'0')}`),timeZone:'UTC',
 }),/position range/);
 assert.deepEqual(naturalTiming({dailyTime:'08:30:00',timeZone:'UTC'}),
   {kind:'daily',daily:{time:'08:30:00',time_zone:'UTC'}});
});

test('separator-tolerant spelling is lower priority than exact configured identifiers',()=>{
 const group=(id,models)=>({id,models});
 const catalog={groups:[
  group('my-dsh',[{id:'big-free',name:'Big Free',reasoning}]),
  group('other',[{id:'big_free',name:'Alternate',reasoning}]),
 ]};
 assert.equal(resolveNatural(catalog,'Big Free').selection.provider,'my-dsh');
 assert.equal(resolveNatural(catalog,'big_free').selection.provider,'other');
 assert.equal(resolveNatural(catalog,'BigFree').code,'ambiguous_model');
 assert.equal(resolveNatural(catalog,'my_dsh/BigFree').selection.provider,'my-dsh');
 assert.equal(resolveNatural(catalog,'my-dsh/---').code,'unknown_model');
 assert.equal(resolveNatural(catalog,'missing/BigFree').code,'unknown_model');
 const unique={groups:[catalog.groups[0]]};
 assert.equal(resolveNatural(unique,'BigFree').selection.model,'big-free');
});
test('qualified alias stays within its provider and exact raw slash IDs still work',()=>{
 const catalog={groups:[
  {id:'known',models:[{id:'unrelated'}]},
  {id:'route-a',models:[{id:'provider/vendor-model'}]},
  {id:'other',models:[{id:'known/missing'},{id:'missing'}]},
 ]};
 assert.equal(resolveNatural(catalog,'known/missing').code,'unknown_model');
 assert.equal(resolveNatural(catalog,'provider/vendor-model').selection.provider,'route-a');
 assert.equal(resolveNatural(catalog,'provider/vendor_model').code,'unknown_model');
 assert.equal(resolveNatural(catalog,'route_a/provider/vendor_model').selection.provider,'route-a');
 const duplicateProviders={groups:[...catalog.groups,{id:'route_a',models:[{id:'not-matching'}]}]};
 assert.equal(resolveNatural(duplicateProviders,'route a/provider/vendor_model').code,'ambiguous_model');
});
test('exact effort display or id takes priority over Chinese alias',()=>{
 const catalog=ds([{...alpha,reasoning:{efforts:[{id:'low',name:'Low'},{id:'other',name:'低'}]}}]);
 assert.equal(resolveNatural(catalog,'ds','低').selection.reasoningEffort,'other');
 assert.equal(resolveNatural(catalog,'ds','低思考').selection.reasoningEffort,'low');
});
test('single and paired timings share native-shaped, canonical zones',()=>{
 assert.equal(naturalTiming({dailyTime:'08:30:00',timeZone:'Etc/UTC'}).daily.time_zone,'UTC');
 assert.match(naturalTiming({dailyTimes:['08:30','12:30'],timeZone:'Etc/UTC'}).rrule,/^DTSTART:20000115T120000Z/);
 for (const timeZone of ['PST','+08:00',' Asia/Shanghai','Asia/Shanghai ','Asia/Shanghai\n','Asia/NotReal']) {
  const message=timeZone==='Asia/NotReal'?/Unknown time zone/:/IANA/;
  assert.throws(()=>naturalTiming({dailyTime:'08:30:00',timeZone}),message);
  assert.throws(()=>naturalTiming({dailyTimes:['08:30','12:30'],timeZone}),message);
 }
});
test('native preflight keeps valid omitted effort dynamic and catches only explicit native incompatibility',async()=>{
 const picked={provider:'ds',model:'big-free'};
 const {signal}=new AbortController();
 let sawRequest;
 const llm={async resolveCallConfig(request,received){
  sawRequest=request;
  assert.equal(received,signal);
  return {...request,reasoningEffort:'high'};
 }};
 assert.equal(await validateNaturalRoute(llm,picked,signal),undefined);
 assert.deepEqual(sawRequest,{provider:'ds',model:'big-free'});
 assert.equal(picked.reasoningEffort,undefined);
 const bad=code=>({async resolveCallConfig(){throw Object.assign(Error('native refusal'),{code});}});
 assert.deepEqual(await validateNaturalRoute(bad('INVALID_MODEL_REASONING'),picked,signal),
  {code:'invalid_model_reasoning_metadata',...picked});
 const explicit={...picked,reasoningEffort:'low'};
 assert.deepEqual(await validateNaturalRoute(bad('UNSUPPORTED_REASONING_EFFORT'),explicit,signal),
  {code:'unsupported_reasoning_effort',...explicit});
 await assert.rejects(validateNaturalRoute(bad('NO_ADAPTER'),picked,signal),{code:'NO_ADAPTER'});
});

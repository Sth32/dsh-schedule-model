import assert from 'node:assert/strict';
import test from 'node:test';
import {observedRequest} from './observe.js';
const e=(type,data)=>({type,data});
const turn=(turn,id)=>[e('turn/start',{turn}),e('step/start',{turn,step:1}),e('user/message',{id,content:['PRIVATE']})];
const header=e('request/header',{header:{config:{provider:'test',model:'alpha',reasoningEffort:'high',secret:'PRIVATE'}}});
test('matched model response returns only safe request metadata',()=>{
 const data=observedRequest([...turn(1,'matching'),header,e('assistant/message',{turn:1,step:1,content:['PRIVATE']})],'matching');
 assert.deepEqual(data,{status:'response_observed',requested:{provider:'test',model:'alpha',reasoningEffort:'high'},providerReturnedModel:null});
});
test('header alone and unrelated response are not observations',()=>{
 const a=[...turn(1,'matching'),header,...turn(2,'other'),e('assistant/message',{turn:2,step:1})];
 assert.equal(observedRequest(a,'matching').status,'request_not_verified');
 assert.equal(observedRequest(a,'unknown').status,'delivery_not_matched');
});
test('attempt without response does not establish provider response model',()=>{
 const data=observedRequest([...turn(1,'matching'),header,e('assistant/attempt',{turn:1,step:1})],'matching');
 assert.equal(data.status,'attempt_recorded');
 assert.equal(data.providerReturnedModel,null);
});

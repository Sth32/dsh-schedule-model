import assert from 'node:assert/strict';
import test from 'node:test';
import {defineTool,delegationDepthOf} from './tool.js';
test('Tool contract uses JSON Schema and checks required/type/enum/finite at direct execution',async()=>{
 const t=defineTool({
  name:'test',parameters:{alias:{type:'string',required:true,enum:['ds']},interval:{type:'number'}},
  output:{schema:{type:'string'},render:()=>[]},execute:a=>a.alias,
 });
 assert.deepEqual(t.parameters,{type:'object',properties:{alias:{type:'string',enum:['ds']},interval:{type:'number'}},required:['alias']});
 assert.equal(await t.execute({alias:'ds'}),'ds');
 await assert.rejects(t.execute({}),{code:'INVALID_ARGS',message:/alias/});
 await assert.rejects(t.execute(Object.assign(new Date(),{alias:'ds'})),{code:'INVALID_ARGS'});
 assert.equal(await t.execute({alias:'ds',extra:1}),'ds');
 await assert.rejects(t.execute({alias:'unknown'}),/alias/);
 await assert.rejects(t.execute({alias:'ds',interval:Infinity}),/interval/);
});
test('effective delegation depth honours runtime and persisted flags',()=>{
 assert.equal(delegationDepthOf({options:{subagentDepth:2},session:{header:{delegationDepth:1}}}),2);
 assert.equal(delegationDepthOf({options:{},session:{header:{delegationDepth:1}}}),1);
 assert.throws(()=>delegationDepthOf({options:{subagentDepth:-1}}),/depth/);
});

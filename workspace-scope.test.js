import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyScheduleWorkspace as classify} from './workspace-scope.js';
const one={id:'workspace-1',title:'One',path:'/profile/one',sessionIds:['actor','own-target']};
const two={id:'workspace-2',title:'Two',path:'/profile/two',sessionIds:['other-target']};
const registry={
  list:()=>[one,two],
  resolveByPath:async path=>{
    if(path==='/runtime/alias-two')return two;
    if(path==='/missing')throw Error('not available');
  },
};
const fresh=cwd=>({target:{kind:'new',create:cwd===undefined?{}:{cwd}},involvedSessionIds:['actor']});
test('new task scope uses canonical execution cwd, never the creating session',async()=>{
  assert.deepEqual(await classify(registry,fresh(one.path),'actor'),{scope:'current',id:one.id,title:one.title});
  assert.deepEqual(await classify(registry,fresh('/runtime/alias-two'),'actor'),{scope:'other',id:two.id,title:two.title});
  assert.deepEqual(await classify(registry,fresh('/runtime/unregistered'),'actor'),{scope:'unassigned'});
  assert.deepEqual(await classify(registry,fresh(),'actor'),{scope:'unassigned'});
  assert.deepEqual(await classify(registry,fresh('/missing'),'actor'),{scope:'unknown'});
});
test('reused task scope uses registered Session membership and a caller with no workspace can still see other scopes',async()=>{
  const task={target:{kind:'session',sessionId:'other-target'},involvedSessionIds:['actor']};
  assert.deepEqual(await classify(registry,task,'actor'),{scope:'other',id:two.id,title:two.title});
  assert.deepEqual(await classify(registry,{target:{kind:'session',sessionId:'unbound'}},'actor'),{scope:'unassigned'});
  assert.deepEqual(await classify(registry,fresh(one.path),'free-agent'),{scope:'other',id:one.id,title:one.title});
});
test('failed or ambiguous membership is unknown; absolute native root title stays private',async()=>{
  assert.deepEqual(await classify(null,fresh(),'actor'),{scope:'unknown'});
  assert.deepEqual(await classify({list:()=>[one,{...two,sessionIds:['actor']}]},fresh(),'actor'),{scope:'unknown'});
  const root={id:'w-root',title:'/mnt/root',path:'/mnt/root',sessionIds:[]};
  assert.deepEqual(await classify({list:()=>[root]},fresh(root.path),'free-agent'),{scope:'other',id:root.id});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {registerReuseAdmin} from './reuse-admin.js';

const requested={provider:'fake',model:'alpha',reasoningEffort:'high'};
const old={provider:'fake',model:'beta',reasoningEffort:'low'};
const id='schedule-one';
const names=['改原会话 / Change original session','新开专用会话 / Open dedicated session','不修改 / Cancel'];
function make({option=0,allowed='allowed-once',unavailable=false,wrong=false,loseOwner=false,denyScope=false}={}){
  const task={id,title:'Inspect this one',target:{kind:'session',sessionId:'session-target'}};
  const called=[];
  let advertised;
  let ownerLive=true;
  const presets={composedPreset:()=>denyScope?'plain':'admin'};
  const actor={session:{id:'session-actor',header:{}},ctx:{get:()=>presets}};
  const ctx={
    typertGateway:{hasLiveClient:()=>ownerLive},
    tools:{get:()=>({}),register(tool){advertised=tool;return ()=>{};}},
    schedule:{view:async()=>task},
    llm:{resolveCallConfig:async()=>({})},
    sessionController:{modelCatalog:async()=>({groups:[{id:'fake',models:[{id:'alpha',name:'Alpha',reasoning:{efforts:[{id:'high',name:'high'}]}}]}]})},
    userQuestions:{ask:async({questions:[q]})=>{
      called.push(['choose',q]);
      return {answers:[{id:q.id,selected:[names[option]],...(wrong?{custom:'yes'}:{})}]};
    }},
    approval:{request:async({reason})=>{
      called.push(['confirm',reason]); if(loseOwner)ownerLive=false; return allowed;
    }},
  };
  registerReuseAdmin(ctx,{managementPreset:'admin',routes:new Map(),prepareReceiving:async()=>unavailable?{code:'receiving_session_busy'}:{
    plan:{taskId:id,sessionId:'session-target',sessionTitle:'Target',from:old,to:requested,
      affectedTasks:[{id,title:task.title},{id:'schedule-two',title:'Sibling scheduled task'}]},
    async commit(){called.push(['keep']);return {status:'changed_original'};},
  },prepareDedicated:async()=>({ok:true,plan:Object.freeze({}),impact:{preset:'normal'}}),
  async commitDedicated(){called.push(['move']);return {status:'changed_destination'};}});
  return {called,execute:async()=>JSON.parse(await advertised.execute({id,model:'Alpha',thinking:'高'},
    {agent:actor,callId:'call-id',signal:new AbortController().signal}))};
}
test('both options are shown together; selected original alone receives approval and write',async()=>{
  const f=make(); assert.deepEqual(await f.execute(),{status:'changed_original'});
  assert.deepEqual(f.called.map(a=>a[0]),['choose','confirm','keep']);
  assert.deepEqual(f.called[0][1].options.map(x=>x.label),names);
  assert.match(f.called[0][1].detail,/Sibling scheduled task.*schedule-two/s);
  assert.match(f.called[0][1].detail,/不复制旧对话上下文/);
  assert.match(f.called[1][1],/Sibling scheduled task/);
  assert.doesNotMatch(f.called[1][1],/新开的专用会话/);
});
test('selected dedicated destination alone receives approval and write',async()=>{
  const f=make({option:1}); assert.deepEqual(await f.execute(),{status:'changed_destination'});
  assert.deepEqual(f.called.map(a=>a[0]),['choose','confirm','move']);
  assert.match(f.called[1][1],/不复制旧对话上下文/);
  assert.doesNotMatch(f.called[1][1],/Sibling scheduled task/);
});
test('cancel, ambiguous custom input, denied approval or losing owner never writes',async()=>{
  for(const opts of [{option:2},{wrong:true},{allowed:'rejected'},{loseOwner:true}]){
    const f=make(opts); assert.equal((await f.execute()).status,'not_changed');
    assert.ok(f.called.every(([call])=>call!=='keep'&&call!=='move'));
  }
});
test('an option blocked by preflight is explained, not selectable or redirected',async()=>{
  const f=make({unavailable:true}); assert.equal((await f.execute()).status,'not_changed');
  assert.deepEqual(f.called.map(a=>a[0]),['choose']);
  assert.deepEqual(f.called[0][1].options.map(x=>x.label),names.slice(1));
  assert.match(f.called[0][1].detail,/原会话有进行中或排队的输入/);
});
test('ordinary preset does not open a privileged prompt',async()=>{
  const f=make({denyScope:true}); assert.equal((await f.execute()).code,'owner_ui_approval_unavailable'); assert.deepEqual(f.called,[]);
});

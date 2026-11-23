import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './creator.js';

test('natural creation pins only the dedicated session title before persisting and scheduling',async()=>{
  const tools=new Map(),calls=[];
  const origin={session:{id:'origin',header:{}}},session={id:'dedicated'};
  let titles={rename:(target,title)=>calls.push(['rename',target,title])};
  const ctx={
    get:name=>name==='sessionTitle'?titles:undefined,
    effect:fn=>fn(),inject(){},
    systemPrompt:{section(){},getSectionOrder(){}},
    tools:{register:spec=>tools.set(spec.name,spec)},
    llm:{resolveCallConfig:async()=>{}},
    sessionController:{
      modelCatalog:async()=>({groups:[{id:'fixture',models:[{id:'alpha'}]}]}),
      create:async()=>{calls.push(['create']);return {sessionId:session.id};},
      resolveAgent:async()=>({agent:{session,model:{select:model=>calls.push(['select',model])}}}),
    },
    sessions:{flush:async target=>{calls.push(['flush',target]);return true;}},
    schedule:{create:async(task,actor)=>{calls.push(['schedule',task,actor]);return {id:'schedule-id'};}},
  };
  apply(ctx);
  const tool=tools.get('schedule_create_with_model');
  assert.equal(tool.parameters.properties.sessionTitle.type,'string');
  assert.ok(!tool.parameters.required.includes('sessionTitle'));
  const base={title:' task title ',prompt:' test ',model:'alpha',intervalMinutes:60};
  const run=args=>tool.execute({...base,...args},{agent:origin});
  for(const [args,expected] of [[{},'task title'],[{sessionTitle:' pinned label '},'pinned label']]){
    calls.length=0;
    await run(args);
    assert.deepEqual(calls,[['create'],['select',{provider:'fixture',model:'alpha'}],['rename',session,expected],
      ['flush',session],['schedule',{title:'task title',prompt:'test',timing:{kind:'every',every_seconds:3600},
        target:{kind:'session',sessionId:'dedicated'}},'origin']]);
  }
  calls.length=0;
  await assert.rejects(run({sessionTitle:'  '}),/Session title must be nonempty/);
  assert.deepEqual(calls,[]);
  titles={rename(){throw new Error('native rename rejected');}};
  await assert.rejects(run({}),/native rename rejected/);
  assert.deepEqual(calls.map(([type])=>type),['create','select']);
  calls.length=0;
  titles=undefined;
  await assert.rejects(run({sessionTitle:'required title'}),/cannot set an explicit session title/);
  assert.deepEqual(calls,[]);
  await run({});
  assert.deepEqual(calls.map(([type])=>type),['create','select','flush','schedule']);
});

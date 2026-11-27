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

test('fresh creation stages guarded native target, persists configuration, then promotes the same task',async t=>{
  const {mkdtemp,readFile,rm,writeFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'schedule-fresh-create-'));
  t.after(()=>rm(dir,{force:true,recursive:true}));
  const tools=new Map(),calls=[],rows=new Map();
  const owner={session:{id:'owner',header:{cwd:dir}},ctx:{get:()=>({composedPreset:()=> 'ptc'})}};
  const model={provider:'fixture',model:'alpha'};
  const file=id=>join(dir,'schedule-model-overrides',id+'.json');
  let mode='normal', sequence=0;
  const ctx={
    get:key=>key==='sessionTitle'?{}:undefined,
    effect:fn=>fn(),inject(keys,fn){if(keys.includes('profileContext'))fn(this);},
    profileContext:{dir},storageDomain:{get:()=>({table:()=>rows})},on(){},
    systemPrompt:{section(){},getSectionOrder(){}},
    tools:{register:spec=>tools.set(spec.name,spec)},llm:{resolveCallConfig:async()=>{}},
    agentPresets:{resolve:async()=>{throw Object.assign(Error('missing preset'),{code:'agent-preset/not-found'});}},
    sessionController:{modelCatalog:async()=>({groups:[{id:'fixture',models:[{id:'alpha'}]}]}),
      create:async()=>assert.fail('must not create a receiving session')},
    schedule:{
      async create(input,actor){
        assert.equal(actor,'owner');
        assert.match(input.target.create.agentPreset,/^dsh-schedule-model\/setup\//);
        assert.deepEqual(input.timing,{kind:'every',every_seconds:3600});
        const id='schedule-fresh-'+(++sequence);
        const row={...input,id,updatedAt:'version-1',status:'active'};
        rows.set(id,row);
        calls.push(['stage',id]);
        await assert.rejects(readFile(file(id)),{code:'ENOENT'});
        if(mode==='store-fails')await writeFile(join(dir,'schedule-model-overrides'),'block the directory');
        return row;
      },
      async edit(input,actor){
        const row=rows.get(input.id);
        assert.equal(actor,'owner');
        assert.equal(input.expectedUpdatedAt,row.updatedAt);
        calls.push([input.action,input.id]);
        if(input.action==='delete'){rows.delete(input.id);return {deleted:true};}
        assert.deepEqual(JSON.parse(await readFile(file(input.id),'utf8')).selection,model);
        assert.deepEqual(input.patch.target,{kind:'new',create:{agentPreset:'ptc',cwd:dir}});
        const promoted={...row,target:input.patch.target};
        if(mode==='conflict')return {id:input.id,code:'schedule_conflict'};
        rows.set(input.id,promoted);
        if(mode==='unconfirmed')throw Error('acknowledgment lost after commit');
        return promoted;
      },
    },
  };
  apply(ctx);
  const tool=tools.get('schedule_create_with_model');
  const run=()=>tool.execute({title:'task',sessionTitle:'Pinned',prompt:'run',model:'alpha',intervalMinutes:60,
    sessionMode:'fresh_each_run'},{agent:owner});
  // Fault before first successful override installation.
  mode='store-fails';
  await assert.rejects(run(),/EEXIST/);
  assert.deepEqual(calls,[['stage','schedule-fresh-1'],['delete','schedule-fresh-1']]);
  assert.equal(rows.size,0);
  await rm(join(dir,'schedule-model-overrides'));
  mode='normal';
  const result=JSON.parse(await run());
  assert.equal(result.sessionReuse,false);
  assert.equal(result.id,'schedule-fresh-2');
  assert.deepEqual(result.target,{kind:'new'});
  assert.equal(JSON.parse(await readFile(join(dir,'schedule-model-overrides',result.id+'.fresh.json'),'utf8')).title,'Pinned');
  mode='conflict';
  await assert.rejects(run(),/not confirmed \(schedule-fresh-3\)/);
  assert.match(rows.get('schedule-fresh-3').target.create.agentPreset,/setup/);
  mode='unconfirmed';
  await assert.rejects(run(),/not confirmed \(schedule-fresh-4\)/);
  assert.equal(rows.get('schedule-fresh-4').target.create.agentPreset,'ptc');
  assert.deepEqual(calls.slice(-4),[['stage','schedule-fresh-3'],['update','schedule-fresh-3'],
    ['stage','schedule-fresh-4'],['update','schedule-fresh-4']]);
});

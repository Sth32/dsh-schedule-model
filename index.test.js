import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, selection } from './index.js';

function host() {
  const hooks = [], validations = [];
  const ctx = {
    agentPresets: {presetForSession: session => session.preset},
    llm: { resolveCallConfig: async model => {
      validations.push(model);
      if (model.model === 'missing') throw new Error('provider model not found');
    }},
    effect(start) {start();},
    on(event, hook) {assert.equal(event, 'agent/created'); hooks.push(hook);},
  };
  async function launch(preset, prompt) {
    let current = {provider:'default',model:'default'};
    const agent = {
      session:{preset},
      model:{ current:()=>current, select:value=>{current=value;} }
    };
    for (const hook of hooks) await hook({agent});
    return prompt(current);
  }
  return {ctx, launch, validations};
}

test('distinct preset destinations resolve independently before the first prompt; legacy follows default', async () => {
  const {ctx, launch, validations} = host();
  apply(ctx,{preset:'a',provider:'ds',model:'alpha',reasoningEffort:'high'});
  apply(ctx,{preset:'b',provider:'other',model:'beta',reasoningEffort:'low'});
  const rows = await Promise.all(['a','standard','b'].map(p => launch(p, chosen => chosen)));
  assert.deepEqual(rows, [
    {provider:'ds',model:'alpha',reasoningEffort:'high'},
    {provider:'default',model:'default'},
    {provider:'other',model:'beta',reasoningEffort:'low'}
  ]);
  assert.equal(validations.length,2);
});

test('invalid routing stops task before prompt instead of using global default', async () => {
  const {ctx,launch} = host();
  apply(ctx,{preset:'broken',provider:'ds',model:'missing'});
  await assert.rejects(launch('broken',()=>assert.fail('prompt started')), /not found/);
});

test('optional effort omitted and malformed settings rejected',()=>{
  assert.deepEqual(selection({provider:'ds',model:'x'}),{provider:'ds',model:'x'});
  assert.throws(()=>selection({provider:'ds',model:'x',reasoningEffort:''}),/reasoningEffort/);
  assert.throws(()=>selection({provider:' ds',model:'x'}),/provider/);
});

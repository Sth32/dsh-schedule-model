// Opt-in only. Intentionally nonzero if the known route-loss risk recurs.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const events=readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse);
const by=name=>events.filter(e=>e.event===name).map(e=>e.value);
assert.deepEqual(by('error'),[]);
const [id]=by('removal_probe_seed');
const [actual]=by('removal_probe_actual');
assert.ok(id);
assert.equal(actual?.id,id);
// The actual local provider request is stronger evidence than model.current().
if (actual.route?.model==='legacy') {
  assert.ok(by('request').some(x=>x.model==='legacy'&&x.provider==='local-test'));
  console.error('KNOWN UNSAFE: a native task retained with the plugin absent sent its prompt to the default provider, not its recorded override.');
  process.exitCode=2;
} else if(actual.route?.model==='alpha'){
  console.log('No route loss observed: retained native task ran on the selected model.');
} else {
  throw new Error('Probe inconclusive: unexpected route');
}

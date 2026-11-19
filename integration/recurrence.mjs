import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {naturalTiming} from '../natural.js';
const {RRule}=await import(pathToFileURL(process.argv[2]).href);
function next(timing,after,count){
  const parsed=RRule.parse(naturalTiming(timing).rrule,{rejectIneffectiveSetPositions:true});
  assert.equal(parsed.kind,'accepted');
  let now=Date.parse(after);
  return Array.from({length:count},()=>{
    const result=parsed.rule.next(now);
    now=Date.parse(result);
    return result;
  });
}
assert.deepEqual(next({dailyTimes:['08:00','17:30'],timeZone:'Asia/Singapore'},'2026-11-19T00:00:00Z',4),[
 '2026-11-19T09:30:00.000Z','2026-11-20T00:00:00.000Z',
 '2026-11-20T09:30:00.000Z','2026-11-21T00:00:00.000Z',
]);
assert.deepEqual(next({dailyTimes:['02:30','08:00','17:30'],timeZone:'America/New_York'},'2026-03-08T00:00:00Z',5),[
 '2026-03-08T12:00:00.000Z','2026-03-08T21:30:00.000Z','2026-03-09T06:30:00.000Z',
 '2026-03-09T12:00:00.000Z','2026-03-09T21:30:00.000Z',
]);
console.log('PASS: actual DSH recurrence expands only exact daily pairs, including spring-forward gaps');

// The engine permits BYSETPOS through 366. 19 hours × 20 minutes
// deliberately reaches that position without exceeding 31 requested pairs.
const hh=n=>String(n).padStart(2,'0');
const boundary=[
 ...Array.from({length:18},(_,i)=>`${hh(i)}:${hh(i)}`),
 '00:18','00:19','18:05',
].sort();
const boundaryTiming={dailyTimes:boundary,timeZone:'UTC'};
assert.match(naturalTiming(boundaryTiming).rrule,/,366$/);
const boundaryResult=next(boundaryTiming,'2026-11-18T23:59:59.999Z',boundary.length+1);
assert.deepEqual(boundaryResult,boundary.map(time=>`2026-11-19T${time}:00.000Z`).concat('2026-11-20T00:00:00.000Z'));
assert.throws(()=>naturalTiming({timeZone:'UTC',
 dailyTimes:boundary.map(time=>time==='18:05'?'18:06':time),
}),/position range/);

// Strictly after the bound; checking inclusive vs exclusive prevents
// re-delivery at the same scheduled instant.
assert.deepEqual(next({dailyTimes:['08:00','08:01'],timeZone:'UTC'},'2026-11-19T08:00:00.000Z',2),[
 '2026-11-19T08:01:00.000Z','2026-11-20T08:00:00.000Z',
]);
console.log('PASS: DSH exact position 366 and strict next-occurrence boundary');

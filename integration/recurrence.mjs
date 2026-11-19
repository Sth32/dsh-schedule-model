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

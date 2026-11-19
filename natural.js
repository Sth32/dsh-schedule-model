const normalize=value=>String(value??'').normalize('NFKC').trim().toLowerCase();
const aliases=new Map([
  ['低','low'],['低思考','low'],['思考低','low'],['低档','low'],
  ['中','medium'],['中等','medium'],['中思考','medium'],
  ['高','high'],['高思考','high'],['极高','xhigh'],['最高','max'],
  ['关闭','none'],['不思考','none'],['关','none'],
]);

// Ignore only common identifier separators, never slash (the route boundary).
const compact=value=>normalize(value).replace(/[\s_.-]+/gu,'');
const names=entry=>[entry.model, entry.name];
const matches=(values,ask,key)=>values.some(value=>key(value)===ask);
const qualified=(all,ask)=>{
  const slash=ask.indexOf('/');
  if(slash<0)return null;
  const provider=ask.slice(0,slash).trim(),model=ask.slice(slash+1).trim();
  if(!compact(provider)||!compact(model))return [];
  const exactProviders=all.filter(row=>normalize(row.provider)===provider);
  if(exactProviders.length){
    const exact=exactProviders.filter(row=>matches(names(row),model,normalize));
    return exact.length?exact:exactProviders.filter(row=>matches(names(row),compact(model),compact));
  }
  // A catalog model id may itself contain a slash, as with OpenRouter.
  // Permit its full exact spelling, never fuzzy/suffix-match it globally.
  const exactId=all.filter(row=>normalize(row.model)===ask);
  if(exactId.length)return exactId;
  const looseProviders=all.filter(row=>compact(row.provider)===compact(provider));
  if(new Set(looseProviders.map(row=>row.provider)).size>1)
    return {ambiguous:looseProviders};
  const exact=looseProviders.filter(row=>matches(names(row),model,normalize));
  return exact.length?exact:looseProviders.filter(row=>matches(names(row),compact(model),compact));
};

export function resolveNatural(catalog,model,thinking){
  const ask=normalize(model);
  const all=catalog.groups.flatMap(g=>g.models.map(m=>({provider:g.id,model:m.id,name:m.name,reasoning:m.reasoning})));
  let candidates=qualified(all,ask);
  if(candidates===null){
    const direct=all.filter(row=>matches(names(row),ask,normalize));
    const loose=compact(ask);
    candidates=direct.length?direct:loose?all.filter(row=>matches(names(row),loose,compact)):[];
    if(!candidates.length&&ask==='ds')
      candidates=all.filter(m=>[m.provider,m.model,m.name].some(x=>/^deepseek(?:[-_ /]|$)/i.test(x)));
  }
  if(candidates.ambiguous)return {
    code:'ambiguous_model',
    candidates:candidates.ambiguous.slice(0,12).map(x=>`${x.provider}/${x.model}`),
  };
  if(candidates.length!==1)return {
    code:candidates.length?'ambiguous_model':'unknown_model',
    candidates:(candidates.length?candidates:all).slice(0,12).map(x=>`${x.provider}/${x.model}`),
  };
  const a=candidates[0];
  const base={provider:a.provider,model:a.model};
  if(thinking===undefined)return {selection:base};
  const raw=normalize(thinking);
  const token=aliases.get(raw);
  const levels=a.reasoning?.efforts??[];
  const byName=effort=>[effort.id,effort.name];
  const direct=levels.filter(effort=>matches(byName(effort),raw,normalize));
  const exact=direct.length||token===undefined?direct:levels.filter(effort=>matches(byName(effort),token,normalize));
  if(exact.length!==1)return {code:'unsupported_or_ambiguous_thinking',...base,
    supported:levels.map(x=>({id:x.id,name:x.name}))};
  return {selection:{...base,reasoningEffort:exact[0].id}};
}

// The native resolver validates adapter-reported defaults as well as explicit
// effort. Do not persist its materialized default: omission follows the
// adapter's active default on each future request.
export async function validateNaturalRoute(llm,selected,signal){
  try{await llm.resolveCallConfig(selected,signal);}
  catch(error){
    signal?.throwIfAborted();
    if(error?.code==='INVALID_MODEL_REASONING'&&selected.reasoningEffort===undefined)
      return {code:'invalid_model_reasoning_metadata',provider:selected.provider,model:selected.model};
    if(error?.code==='UNSUPPORTED_REASONING_EFFORT')
      return {code:'unsupported_reasoning_effort',...selected};
    throw error;
  }
}

export function naturalTiming(a){
  if(Number(a.intervalMinutes!==undefined)+Number(a.dailyTime!==undefined)+Number(a.dailyTimes!==undefined)+Number(a.at!==undefined)!==1)
    throw new Error('Choose exactly one schedule: intervalMinutes, dailyTime, dailyTimes or at.');
  if(a.intervalMinutes!==undefined){
    if(!Number.isSafeInteger(a.intervalMinutes)||a.intervalMinutes<1||!Number.isSafeInteger(a.intervalMinutes*60))
      throw new Error('The interval must be a positive whole number of minutes.');
    return {kind:'every',every_seconds:a.intervalMinutes*60};
  }
  if(a.at!==undefined) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(a.at))
      throw new Error('The one-time date must include a UTC offset.');
    return {kind:'at',at:a.at};
  }
  const zone=canonicalDailyZone(a.timeZone);
  if(a.dailyTimes!==undefined)return multiDailyTiming(a.dailyTimes,zone);
  return {kind:'daily',daily:{time:a.dailyTime,time_zone:zone}};
}

// Mirror DSH's time-zone selector contract for both entry points. ICU checks
// membership and canonicalizes aliases; strict shape keeps TZID data safe.
const areaLocation=/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;
function canonicalDailyZone(zone){
  if(typeof zone!=='string'||!zone)throw new Error('Daily schedules need an explicit time zone.');
  if(zone.trim()!==zone||(zone!=='UTC'&&!areaLocation.test(zone)))
    throw new Error('Daily schedules require UTC or an explicit IANA Area/Location time zone.');
  let canonical;
  try{canonical=new Intl.DateTimeFormat('en-US',{timeZone:zone}).resolvedOptions().timeZone;}
  catch{throw new Error('Unknown time zone.');}
  if(canonical!=='UTC'&&!areaLocation.test(canonical))
    throw new Error('The time zone must resolve to UTC or an IANA Area/Location name.');
  return canonical;
}

// One native recurrence. DSH chooses BYSETPOS within each wall-clock day
// before resolving local timestamps (including DST gaps).
function multiDailyTiming(times,zone){
  if(!Array.isArray(times)||times.length<2||times.length>31||
      times.some(t=>typeof t!=='string'||! /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)))
    throw new Error('Daily times must contain 2–31 local HH:mm values.');
  const unique=[...new Set(times)].sort();
  if(unique.length!==times.length)throw new Error('Daily times may not contain duplicates.');
  const pairs=unique.map(t=>t.split(':').map(Number));
  const hours=[...new Set(pairs.map(([hour])=>hour))];
  const minutes=[...new Set(pairs.map(([,minute])=>minute))].sort((a,b)=>a-b);
  const positions=pairs.map(([h,m])=>hours.indexOf(h)*minutes.length+minutes.indexOf(m)+1);
  const fullProduct=pairs.length===hours.length*minutes.length;
  if(!fullProduct&&positions.some(i=>i>366))
    throw new Error('These exact daily times exceed the native RRULE position range; no task was created.');
  // A fixed historical noon avoids anchoring creation to a possibly missing
  // or ambiguous wall time on a daylight-saving transition day.
  const start=zone==='UTC'?'DTSTART:20000115T120000Z':`DTSTART;TZID=${zone}:20000115T120000`;
  return {kind:'rrule',rrule:`${start}\nRRULE:FREQ=DAILY;BYHOUR=${hours};BYMINUTE=${minutes};BYSECOND=0`+
    (fullProduct?'':`;BYSETPOS=${positions}`)};
}

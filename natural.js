const normalize=value=>String(value??'').normalize('NFKC').trim().toLowerCase();
const aliases=new Map([
  ['低','low'],['低思考','low'],['思考低','low'],['低档','low'],
  ['中','medium'],['中等','medium'],['中思考','medium'],
  ['高','high'],['高思考','high'],['极高','xhigh'],['最高','max'],
  ['关闭','none'],['不思考','none'],['关','none'],
]);

export function resolveNatural(catalog,model,thinking){
  const ask=normalize(model);
  const all=catalog.groups.flatMap(g=>g.models.map(m=>({provider:g.id,model:m.id,name:m.name,reasoning:m.reasoning})));
  const direct=all.filter(m=>[m.model,m.name,`${m.provider}/${m.model}`].some(x=>normalize(x)===ask));
  const candidates=direct.length?direct:ask==='ds'
    ?all.filter(m=>[m.provider,m.model,m.name].some(x=>/^deepseek(?:[-_ /]|$)/i.test(x)))
    :[];
  if(candidates.length!==1)return {
    code:candidates.length?'ambiguous_model':'unknown_model',
    candidates:(candidates.length?candidates:all).slice(0,12).map(x=>`${x.provider}/${x.model}`),
  };
  const a=candidates[0];
  const base={provider:a.provider,model:a.model};
  if(thinking===undefined)return {selection:base};
  const raw=normalize(thinking);
  const token=aliases.get(raw)??raw;
  const levels=a.reasoning?.efforts??[];
  const exact=levels.filter(x=>[normalize(x.id),normalize(x.name)].includes(raw)
    || [normalize(x.id),normalize(x.name)].includes(token));
  if(exact.length!==1)return {code:'unsupported_or_ambiguous_thinking',...base,
    supported:levels.map(x=>({id:x.id,name:x.name}))};
  return {selection:{...base,reasoningEffort:exact[0].id}};
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
  if(!a.timeZone)throw new Error('Daily schedules need an explicit time zone.');
  if(a.dailyTimes!==undefined)return multiDailyTiming(a.dailyTimes,a.timeZone);
  return {kind:'daily',daily:{time:a.dailyTime,time_zone:a.timeZone}};
}


// One native recurrence. DSH chooses BYSETPOS within each wall-clock day
// before resolving local timestamps (including DST gaps).
function multiDailyTiming(times,zone){
  if(!Array.isArray(times)||times.length<2||times.length>31||
      times.some(t=>typeof t!=='string'||! /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)))
    throw new Error('Daily times must contain 2–31 local HH:mm values.');
  if(!/^(?:UTC|[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(zone))
    throw new Error('Daily times require UTC or an explicit IANA Area/Location time zone.');
  try{new Intl.DateTimeFormat('en',{timeZone:zone});}
  catch{throw new Error('Unknown time zone.');}
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

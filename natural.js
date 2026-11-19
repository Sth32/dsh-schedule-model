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
  if(Number(a.intervalMinutes!==undefined)+Number(a.dailyTime!==undefined)+Number(a.at!==undefined)!==1)
    throw new Error('Choose exactly one schedule: intervalMinutes, dailyTime or at.');
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
  return {kind:'daily',daily:{time:a.dailyTime,time_zone:a.timeZone}};
}

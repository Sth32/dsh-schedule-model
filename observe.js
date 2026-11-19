// Correlate a durable schedule delivery with exactly its first model request.
export function observedRequest(events, messageId) {
  let header, turn, step, turnKnown=false;
  let found=false, result;
  for (const {type,data} of events) {
    if (type==='request/header') header=data?.header?.config;
    if (type==='turn/start') {
      if (found) break;
      turn=data?.turn; step=undefined; turnKnown=true;
    }
    if (type==='step/start') step=data?.step;
    if (type==='user/message' && data?.id===messageId && turnKnown) found=true;
    if (!found || !['assistant/message','assistant/attempt'].includes(type) ||
        data?.turn!==turn || data?.step!==step) continue;
    // Prefer a durable assistant source if exposed, otherwise use the header
    // only when an assistant outcome proves this step attempted inference.
    if (header &&
        typeof header.provider==='string' && typeof header.model==='string') {
      result={provider:header.provider,model:header.model,reasoningEffort:header.reasoningEffort??null};
    }
    return {status:type==='assistant/message'?'response_observed':'attempt_recorded',
      requested:result??null,providerReturnedModel:null};
  }
  return {status:found?'request_not_verified':'delivery_not_matched',
    requested:null,providerReturnedModel:null};
}

export async function inspectLatest(controller, delivery, signal) {
  const address={kind:'session',sessionId:delivery.targetSessionId};
  let page, beforeSeq, throughSeq, events=[];
  for(let i=0;i<4;i++){
    page=await controller.events({address,maxMessages:50,
      ...(beforeSeq===undefined?{}:{beforeSeq,throughSeq})},signal);
    throughSeq??=page.cursor;
    const part=page.records.map(x=>x.event).filter(Boolean);
    events=part.concat(events);
    if(!page.hasMore||!part.length) break;
    beforeSeq=part[0].seq;
  }
  return observedRequest(events,delivery.messageId);
}

// A dedicated existing Session uses DSH's native persisted model selection.
// Read it passively; this is the configuration, not evidence of execution.
export async function configuredSessionModel(controller,sessionId,signal){
  const address={kind:'session',sessionId};
  let beforeSeq,throughSeq;
  for(let i=0;i<4;i++){
    const page=await controller.events({address,maxMessages:50,
      ...(beforeSeq===undefined?{}:{beforeSeq,throughSeq})},signal);
    throughSeq??=page.cursor;
    const events=page.records.map(x=>x.event).filter(Boolean);
    for(const e of [...events].reverse()){
      const m=e.data;
      if(e.type==='model/selection' && typeof m?.provider==='string'&&typeof m.model==='string')
        return {provider:m.provider,model:m.model,reasoningEffort:m.reasoningEffort??null};
    }
    if(!page.hasMore||!events.length) break;
    beforeSeq=events[0].seq;
  }
  return null;
}

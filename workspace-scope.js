// Workspace is descriptive only. It never confers or widens authorization.
// Resolve the current execution destination, not where a task was authored.
export async function classifyScheduleWorkspace(registry,task,actorId){
  if(!registry)return {scope:'unknown'};
  try{
    const workspaces=registry.list();
    const belongs=id=>typeof id==='string'?workspaces.filter(row=>row.sessionIds.includes(id)):[];
    const actors=belongs(actorId);
    if(actors.length>1)return {scope:'unknown'};
    const target=task?.target;
    let workspace;
    if(target?.kind==='session'){
      if(typeof target.sessionId!=='string'||!target.sessionId)return {scope:'unknown'};
      const matches=belongs(target.sessionId);
      if(matches.length>1)return {scope:'unknown'};
      workspace=matches[0];
    }else if(target?.kind==='new'||target?.kind==='new_once'){
      // Same API used by the scheduler when joining the target workspace.
      if(target.create?.cwd!==undefined){
        if(typeof target.create.cwd!=='string'||!target.create.cwd)return {scope:'unknown'};
        workspace=workspaces.find(row=>row.path===target.create.cwd)??await registry.resolveByPath(target.create.cwd);
      }
    }else return {scope:'unknown'};
    if(!workspace)return {scope:'unassigned'};
    // Some directory roots have the absolute path as the native fallback title.
    // Avoid emitting a raw path; the stable Workspace ID is sufficient to
    // distinguish these or two otherwise identically titled workspaces.
    const title=typeof workspace.title==='string'&&workspace.title!==workspace.path
      ?workspace.title.replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,120):null;
    return {scope:workspace.id===actors[0]?.id?'current':'other',id:workspace.id,...(title?{title}:{})};
  }catch{return {scope:'unknown'};}
}

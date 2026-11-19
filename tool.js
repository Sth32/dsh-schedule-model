// ToolRegistry's plain public contract; no DSH SDK copy is installed into the
// profile. Each host already owns its matching tools/subagent services.
class ToolArgsError extends Error {
  constructor(violations){
    super(`invalid arguments: ${violations.join('; ')}`);
    this.name='ToolArgsError';
    this.code='INVALID_ARGS';
    this.violations=violations;
  }
}
function plainRecord(value){
  if(value===null||typeof value!=='object')return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}
export function defineTool(spec) {
  const {parameters: fields, execute, ...rest}=spec;
  const properties=Object.fromEntries(Object.entries(fields).map(([key,{required,...schema}])=>[key,schema]));
  const required=Object.keys(fields).filter(k=>fields[k].required);
  return {
    ...rest,
    parameters:{type:'object',properties,...(required.length?{required}:{})},
    async execute(args,context){
      if(!plainRecord(args))throw new ToolArgsError(['expected an object']);
      const violations=[];
      for(const [key,schema] of Object.entries(fields)){
        const value=Object.hasOwn(args,key)?args[key]:undefined;
        if(value===undefined && !schema.required)continue;
        if(typeof value!==schema.type || (typeof value==='number'&&!Number.isFinite(value)) ||
          (schema.enum && !schema.enum.includes(value)))violations.push(`Invalid ${key}`);
      }
      if(violations.length) throw new ToolArgsError(violations);
      return execute(args,context);
    },
  };
}

export function delegationDepthOf(agent) {
  const configured=agent.options?.subagentDepth??0;
  const stored=agent.session?.header?.delegationDepth??0;
  if([configured,stored].some(d=>!Number.isSafeInteger(d)||d<0||Object.is(d,-0)))
    throw new TypeError('Invalid delegation depth');
  return Math.max(configured,stored);
}

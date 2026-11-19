export const name = 'schedule-model-pin';
export const inject = ['agentPresets', 'llm'];
function field(value, key) {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    throw new TypeError(`${key} must be a nonempty, trimmed string`);
  }
  return value;
}

export function selection(config = {}) {
  const result = { provider: field(config.provider, 'provider'), model: field(config.model, 'model') };
  if (config.reasoningEffort !== undefined)
    result.reasoningEffort = field(config.reasoningEffort, 'reasoningEffort');
  return Object.freeze(result);
}

export function apply(ctx, config) {
  const preset = field(config?.preset, 'preset');
  const selected = selection(config);
  ctx.on('agent/created', async ({ agent }) => {
    if (ctx.agentPresets.presetForSession(agent.session) !== preset) return;
    // Resolve with the real provider registry; a rejected route aborts creation.
    await ctx.llm.resolveCallConfig(selected);
    const old = agent.model.current();
    if (old?.provider !== selected.provider || old?.model !== selected.model ||
        old?.reasoningEffort !== selected.reasoningEffort) {
      agent.model.select(selected);
    }
  });
}

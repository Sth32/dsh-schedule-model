#!/usr/bin/env bash
# Start an isolated DSH Web instance for manual GUI acceptance. No real model
# or existing DSH profile is used. Keep this process open during verification.
set -euo pipefail
umask 077
prefix="$(realpath "${1:?usage: bash integration/gui.sh /path/to/dsh-npm-prefix [port]}")"
port="${2:-17447}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export DSH_HOME="$work/dsh" XDG_DATA_HOME="$work/xdg" npm_config_cache="$work/npm"
export DSH_TELEMETRY_DISABLED=1 DSH_GUI_TEST_CWD="$work/workspace"
export DSH_E2E_LOG="$work/gui-evidence.jsonl"
export DSH_E2E_LLM_MODULE="${DSH_E2E_LLM_MODULE:-$prefix/node_modules/@deepseek-ai/dsh-llm/lib/index.js}"
dsh="$prefix/node_modules/.bin/dsh"
pack="$(cd "$root"; npm pack --pack-destination "$work" --silent)"
test -f "$work/$pack"
printf 'DSH version: '; "$dsh" --version
"$dsh" plugin --profile web add --store-dir "$work/pnpm" "$work/$pack"
profile="$DSH_HOME/profiles/web"
fixture="$profile/node_modules/local-dsh-schedule-e2e"
mkdir -p "$fixture"
printf '%s\n' '{"name":"local-dsh-schedule-e2e","type":"module","exports":"./index.js"}' > "$fixture/package.json"
cp "$root/integration/gui-fixture.js" "$fixture/index.js"
cp "$root/integration/startup-briefing.js" "$fixture/startup-briefing.js"
if [[ "${DSH_GUI_CENTRAL:-0}" == 1 || "${DSH_GUI_REUSE:-0}" == 1 ]]; then
  sed '/^    routes:$/i\    managementPreset: schedule-model-management' "$root/integration/fixture.yml" > "$profile/cordis.patch.yml"
else
  cp "$root/integration/fixture.yml" "$profile/cordis.patch.yml"
fi
printf '\nOpen the local launch URL below in a test browser. Do not copy its credential to any report.\n'
printf 'Temporary mock request evidence: %s\n' "$DSH_E2E_LOG"
if [[ "${DSH_GUI_OPEN_BROWSER:-0}" == 1 ]]; then
  "$dsh" web --port "$port"
else
  "$dsh" web --port "$port" --no-open
fi

#!/usr/bin/env bash
# Pass an isolated npm prefix containing @deepseek-ai/dsh@0.2.2 RC or stable.
set -euo pipefail
prefix="$(realpath "${1:?usage: integration/run.sh /path/to/isolated/dsh/npm-prefix}")"
root="$(cd "$(dirname "$0")/.." && pwd)"
testdir="$(mktemp -d)"
trap 'rm -rf "$testdir"' EXIT
export DSH_HOME="$testdir/dsh" XDG_DATA_HOME="$testdir/xdg" npm_config_cache="$testdir/npm"
export DSH_E2E_LOG="$testdir/results.jsonl" DSH_E2E_LLM_MODULE="${DSH_E2E_LLM_MODULE:-$prefix/node_modules/@deepseek-ai/dsh-llm/lib/index.js}"
dsh="$prefix/node_modules/.bin/dsh"
(cd "$root"; npm pack --pack-destination "$testdir" --silent)
"$dsh" plugin --profile web add --store-dir "$testdir/pnpm" "$testdir/dsh-schedule-model-0.1.5.tgz"
profile="$DSH_HOME/profiles/web"
"$dsh" --profile web --dump-config > "$testdir/composed.yml"
grep -q 'id: schedule-model-natural' "$testdir/composed.yml"
mkdir -p "$profile/node_modules/local-dsh-schedule-e2e"
printf '%s\n' '{"name":"local-dsh-schedule-e2e","type":"module","exports":"./index.js"}' > "$profile/node_modules/local-dsh-schedule-e2e/package.json"
cp "$root/integration/fixture.js" "$profile/node_modules/local-dsh-schedule-e2e/index.js"
cp "$root/integration/override-fixture.js" "$profile/node_modules/local-dsh-schedule-e2e/override-fixture.js"
cp "$root/integration/fixture.yml" "$profile/cordis.patch.yml"
run_host() {
  # Keep startup logs private: DSH logs the Web's one-time launch credential.
  local rc=0
  timeout --signal=TERM 18s "$dsh" web --port 0 --no-open > "$testdir/host.log" 2>&1 || rc=$?
  if [[ $rc != 124 && $rc != 0 ]]; then
    sed -E 's/(token=)[^ &]+/\1[redacted]/g' "$testdir/host.log" >&2
    return "$rc"
  fi
}
node "$root/integration/recurrence.mjs" "$prefix/node_modules/@deepseek-ai/dsh-util-time/lib/index.js"
run_host
DSH_E2E_RESTART=1 run_host
node "$root/integration/assert.mjs" "$DSH_E2E_LOG" || { cat "$DSH_E2E_LOG"; exit 1; }

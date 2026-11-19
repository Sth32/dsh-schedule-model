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
candidate_filename="$(cd "$root"; npm pack --pack-destination "$testdir" --silent)"
candidate="$testdir/$candidate_filename"
[[ -f "$candidate" ]] || { echo "npm pack did not produce a candidate tarball" >&2; exit 1; }
candidate_version="$(node -p 'require(process.argv[1]).version' "$root/package.json")"
profile="$DSH_HOME/profiles/web"
run_host() {
  # Keep startup logs private: DSH logs the Web's one-time launch credential.
  local rc=0
  timeout --signal=TERM "${DSH_E2E_HOST_TIMEOUT:-18s}" "$dsh" web --port 0 --no-open > "$testdir/host.log" 2>&1 || rc=$?
  if [[ $rc != 124 && $rc != 0 ]]; then
    sed -E 's/(token=)[^ &]+/\1[redacted]/g' "$testdir/host.log" >&2
    return "$rc"
  fi
}
install() {
  "$dsh" plugin --profile web add --store-dir "$testdir/pnpm" "$1"
  "$dsh" --profile web --dump-config > "$testdir/composed.yml"
  grep -q 'id: schedule-model-natural' "$testdir/composed.yml"
  local installed
  installed="$(node -p 'require(process.argv[1]).version' "$profile/node_modules/dsh-schedule-model/package.json")"
  [[ "$installed" == "$2" ]] || { echo "Expected plugin $2, got $installed" >&2; exit 1; }
}
setup_fixture() {
mkdir -p "$profile/node_modules/local-dsh-schedule-e2e"
printf '%s\n' '{"name":"local-dsh-schedule-e2e","type":"module","exports":"./index.js"}' > "$profile/node_modules/local-dsh-schedule-e2e/package.json"
cp "$root/integration/fixture.js" "$profile/node_modules/local-dsh-schedule-e2e/index.js"
cp "$root/integration/startup-briefing.js" "$profile/node_modules/local-dsh-schedule-e2e/startup-briefing.js"
cp "$root/integration/override-fixture.js" "$profile/node_modules/local-dsh-schedule-e2e/override-fixture.js"
cp "$root/integration/upgrade-fixture.js" "$profile/node_modules/local-dsh-schedule-e2e/upgrade-fixture.js"
cp "$root/integration/fixture.yml" "$profile/cordis.patch.yml"
if [[ ${DSH_E2E_LONG_HISTORY:-0} == 1 ]]; then
  cat >> "$profile/cordis.patch.yml" <<'YAML'
- id: schedule
  config:
    newSessionIntervalSeconds: 60
YAML
fi
}
if [[ -n ${DSH_E2E_UPGRADE_FROM:-} ]]; then
  old_package="$(realpath "$DSH_E2E_UPGRADE_FROM")"
  old_version="$(tar -xOzf "$old_package" package/package.json | node -e 'const {name,version}=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(name!=="dsh-schedule-model" || !version) process.exit(1); console.log(version)')"
  [[ "$old_version" != "$candidate_version" ]] || {
    echo "A genuine upgrade requires different seed and candidate versions ($old_version)." >&2; exit 1;
  }
  export DSH_E2E_UPGRADE_SEED_VERSION="$old_version"
  install "$old_package" "$old_version"
  setup_fixture
  DSH_E2E_UPGRADE_SEED=1 run_host
  grep -q '"event":"upgrade_seed"' "$DSH_E2E_LOG"
fi
install "$candidate" "$candidate_version"
setup_fixture
if [[ ${DSH_E2E_PROBE_REMOVAL:-0} == 1 ]]; then
  DSH_E2E_REMOVAL_PROBE=seed run_host
  grep -q '"event":"removal_probe_seed"' "$DSH_E2E_LOG"
  "$dsh" plugin --profile web remove --store-dir "$testdir/pnpm" dsh-schedule-model
  DSH_E2E_REMOVAL_PROBE=verify run_host
  node "$root/integration/known-unsafe-removal.mjs" "$DSH_E2E_LOG"
  exit
fi
node "$root/integration/recurrence.mjs" "$prefix/node_modules/@deepseek-ai/dsh-util-time/lib/index.js"
if [[ ${DSH_E2E_LONG_HISTORY:-0} == 1 ]]; then
  DSH_E2E_HOST_TIMEOUT=78s run_host
else
  run_host
fi
DSH_E2E_RESTART=1 run_host
node "$root/integration/assert.mjs" "$DSH_E2E_LOG" || { cat "$DSH_E2E_LOG"; exit 1; }

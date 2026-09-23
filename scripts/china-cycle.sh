#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f /etc/nodeprobe/china.env ]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/nodeprobe/china.env
  set +a
fi

export CHINA_MAX_NODES="${CHINA_MAX_NODES:-30}"
export CHINA_PROBE_CONCURRENCY="${CHINA_PROBE_CONCURRENCY:-8}"

CANDIDATE_RUN_FILE="${CHINA_CANDIDATE_RUN_FILE:-data/.china-candidate-run}"
PAIR_CANDIDATE_RUN_FILE="${CHINA_PAIR_CANDIDATE_RUN_FILE:-data/.china-pair-candidate-run}"

candidate_run_is_new() {
  local file="$1"
  local marker="$2"
  [ -f "$file" ] || return 0
  local run_id
  run_id="$(node -e 'const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(d.generatedAt||""));' "$file")"
  [ -n "$run_id" ] || return 0
  [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$run_id" ]
}

mark_candidate_run() {
  local file="$1"
  local marker="$2"
  local run_id
  run_id="$(node -e 'const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(d.generatedAt||""));' "$file")"
  printf '%s\n' "$run_id" > "$marker"
}

if npm run china-sync -- pull-candidates; then
  if candidate_run_is_new "${CHINA_CANDIDATE_FILE:-data/china-probe-candidates.json}" "$CANDIDATE_RUN_FILE"; then
    echo 'Using new China candidate feed from B2.'
    npm run china-probe
    npm run china-sync -- push-observations
    mark_candidate_run "${CHINA_CANDIDATE_FILE:-data/china-probe-candidates.json}" "$CANDIDATE_RUN_FILE"
  else
    echo 'China candidate feed already consumed; skipping duplicate probe.'
  fi
else
  echo 'No usable China candidate feed; pulling Stable for discovery bootstrap.'
  npm run china-sync -- pull-stable
  npm run china-assets
  npm run china-probe
  npm run china-sync -- push-observations
  mark_candidate_run "${CHINA_CANDIDATE_FILE:-data/china-probe-candidates.json}" "$CANDIDATE_RUN_FILE"
fi

if npm run china-sync -- pull-pair-candidates; then
  if candidate_run_is_new "${CHINA_RELAY_CANDIDATE_FILE:-data/china-relay-pair-candidates.json}" "$PAIR_CANDIDATE_RUN_FILE"; then
    echo 'Using new China relay pair candidate feed from B2.'
    npm run china-relay-probe
    npm run china-sync -- push-pair-observations
    mark_candidate_run "${CHINA_RELAY_CANDIDATE_FILE:-data/china-relay-pair-candidates.json}" "$PAIR_CANDIDATE_RUN_FILE"
  else
    echo 'China relay pair candidate feed already consumed; skipping duplicate pair probe.'
  fi
else
  echo 'No usable China relay pair candidate feed; generating a local bootstrap pair set.'
  npm run china-relay-candidates
  npm run china-relay-probe
  npm run china-sync -- push-pair-observations
  mark_candidate_run "${CHINA_RELAY_CANDIDATE_FILE:-data/china-relay-pair-candidates.json}" "$PAIR_CANDIDATE_RUN_FILE"
fi

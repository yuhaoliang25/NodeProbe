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

export CHINA_MAX_NODES="${CHINA_MAX_NODES:-300}"
export CHINA_PROBE_CONCURRENCY="${CHINA_PROBE_CONCURRENCY:-8}"
export CHINA_RELEASE_ID="${CHINA_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

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

# Flush any observations left by a previous interrupted publish. The local
# China asset state remains authoritative; B2 is an archive/inbox transport.
npm run china-sync -- push-observations || true
npm run china-sync -- push-pair-observations || true

# Stable is discovery input only. A missing/invalid Stable feed must not replace
# the persistent China asset state or stop its maintenance loop.
npm run china-sync -- pull-stable || echo 'Global Stable unavailable; continuing from persistent China state.'

if npm run china-sync -- pull-candidates; then
  if candidate_run_is_new "${CHINA_CANDIDATE_FILE:-data/china-probe-candidates.json}" "$CANDIDATE_RUN_FILE"; then
    echo 'Using new China candidate feed from B2.'
    npm run china-probe
    npm run china-apply
    mark_candidate_run "${CHINA_CANDIDATE_FILE:-data/china-probe-candidates.json}" "$CANDIDATE_RUN_FILE"
    npm run china-sync -- push-observations
  else
    echo 'China candidate feed already consumed; skipping duplicate probe.'
  fi
else
  echo 'No usable China candidate feed; generating candidates from persistent China assets and Stable discovery.'
  npm run china-assets
  npm run china-probe
  npm run china-apply
  mark_candidate_run "${CHINA_CANDIDATE_FILE:-data/china-probe-candidates.json}" "$CANDIDATE_RUN_FILE"
  npm run china-sync -- push-observations
fi

if npm run china-sync -- pull-pair-candidates; then
  if candidate_run_is_new "${CHINA_RELAY_CANDIDATE_FILE:-data/china-relay-pair-candidates.json}" "$PAIR_CANDIDATE_RUN_FILE"; then
    echo 'Using new China relay pair candidate feed from B2.'
    npm run china-relay-probe
    npm run china-pair-apply
    mark_candidate_run "${CHINA_RELAY_CANDIDATE_FILE:-data/china-relay-pair-candidates.json}" "$PAIR_CANDIDATE_RUN_FILE"
    npm run china-sync -- push-pair-observations
  else
    echo 'China relay pair candidate feed already consumed; skipping duplicate pair probe.'
  fi
else
  echo 'No usable China relay pair candidate feed; generating a local China-only pair set.'
  npm run china-relay-candidates
  npm run china-relay-probe
  npm run china-pair-apply
  mark_candidate_run "${CHINA_RELAY_CANDIDATE_FILE:-data/china-relay-pair-candidates.json}" "$PAIR_CANDIDATE_RUN_FILE"
  npm run china-sync -- push-pair-observations
fi

# From this point onward the China machine owns the entire state transition.
# No GitHub workflow is needed to apply observations or derive the next feed.
npm run china-assets
npm run china-relay-candidates
npm run china-pairs
npm run china-pools
npm run china-elite
npm run china-sticky
npm run client-config
npm run china-diagnostics

# Publish the completed state/results. release.json is uploaded last so the
# GitHub publisher only observes a completed China generation.
npm run china-sync -- publish-results

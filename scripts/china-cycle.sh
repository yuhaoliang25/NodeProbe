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

npm run china-sync -- pull-candidates
npm run china-probe
npm run china-sync -- push-observations
if npm run china-sync -- pull-pair-candidates; then
  npm run china-relay-probe
  npm run china-sync -- push-pair-observations
else
  echo 'No China relay pair candidate feed yet; skipping pair experiment.'
fi

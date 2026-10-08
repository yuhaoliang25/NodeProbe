#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Prevent overlapping China cycles from concurrently reading/writing the
# persistent discovery queue and other local state files.
LOCK_FILE="${CHINA_CYCLE_LOCK_FILE:-/tmp/nodeprobe-china-cycle.lock}"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another China cycle is already running; exiting without overlap."
  exit 0
fi

if [ -f /etc/nodeprobe/china.env ]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/nodeprobe/china.env
  set +a
fi

export CHINA_MAX_NODES="${CHINA_MAX_NODES:-300}"
export CHINA_PROBE_CONCURRENCY="${CHINA_PROBE_CONCURRENCY:-8}"
export CHINA_B2_LIST_TIMEOUT_MS="${CHINA_B2_LIST_TIMEOUT_MS:-15000}"
export CHINA_RELEASE_ID="${CHINA_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

# Cheap gate before any B2 mutation, probing, or test execution. This catches
# syntax errors, undefined variables, invalid runtime configuration, and any
# module-supplied preflight checks before a long cycle can fail at the end.
npm run china-preflight

# Local observation batches are the crash-safe handoff between probing and
# application. They are consumed once and cleaned up locally after the resulting
# persistent state is saved. Raw observations are never uploaded to B2.
# Stable is discovery input only. Rebuild the local candidate schedule every
# cycle from the persistent China asset pool plus the current Stable discovery
# feed. The B2 candidate file is an exported runtime artifact, not a lock or
# once-only work queue. Known China assets must continue to be maintained even
# when the B2 candidate file has the same generatedAt as the previous cycle.
npm run china-sync -- pull-stable || echo 'Global Stable unavailable; continuing from persistent China state.'
npm run china-sync -- pull-discovery-queue || true
npm run china-assets
npm run china-probe
npm run china-apply

# Relay/pair experiments are derived from the current persistent China asset
# pool. As with ordinary candidates, the generated pair feed is a scheduling
# artifact, not a once-only B2 work queue. Rebuild it every cycle so pair
# evidence can evolve with the current China assets.
npm run china-relay-candidates
npm run china-relay-probe
npm run china-pair-apply

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

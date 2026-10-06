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

# Flush any observations left by a previous interrupted publish. The local
# China asset state remains authoritative; B2 is an archive/inbox transport.
npm run china-sync -- push-observations || true
npm run china-sync -- push-pair-observations || true

# Stable is discovery input only. Rebuild the local candidate schedule every
# cycle from the persistent China asset pool plus the current Stable discovery
# feed. The B2 candidate file is an exported runtime artifact, not a lock or
# once-only work queue. Known China assets must continue to be maintained even
# when the B2 candidate file has the same generatedAt as the previous cycle.
npm run china-sync -- pull-stable || echo 'Global Stable unavailable; continuing from persistent China state.'
npm run china-assets
npm run china-probe
npm run china-apply
npm run china-sync -- push-observations

# Relay/pair experiments are derived from the current persistent China asset
# pool. As with ordinary candidates, the generated pair feed is a scheduling
# artifact, not a once-only B2 work queue. Rebuild it every cycle so pair
# evidence can evolve with the current China assets.
npm run china-relay-candidates
npm run china-relay-probe
npm run china-pair-apply
npm run china-sync -- push-pair-observations

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

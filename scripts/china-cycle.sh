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
export CHINA_RELEASE_ID="${CHINA_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
export CHINA_OBSERVATION_RUN_ID="${CHINA_OBSERVATION_RUN_ID:-$CHINA_RELEASE_ID}"

# Capture the publication inputs before this cycle changes any persistent state.
# Observation application continues against the live files; publication builders
# later read only this immutable snapshot.
ORIGINAL_CHINA_ASSET_FILE="${CHINA_ASSET_FILE:-data/china-node-assets.json}"
ORIGINAL_CHINA_PAIR_KNOWLEDGE_FILE="${CHINA_PAIR_KNOWLEDGE_FILE:-data/china-pair-knowledge.json}"
ORIGINAL_CHINA_STICKY_STATE_FILE="${CHINA_STICKY_STATE_FILE:-data/china-sticky.json}"
export CHINA_PUBLICATION_SNAPSHOT_DIR="${CHINA_PUBLICATION_SNAPSHOT_DIR:-data/china-publication-snapshots/$CHINA_RELEASE_ID}"

# Cheap gate before any B2 mutation, probing, or test execution. This catches
# syntax errors, undefined variables, invalid runtime configuration, and any
# module-supplied preflight checks before a long cycle can fail at the end.
npm run --silent china-preflight

# Restore or reconcile the persistent local asset inventory against B2 before
# freezing this cycle's publication inputs. The node inventory is monotonic:
# ordinary lifecycle transitions do not delete endpoint records.
npm run --silent china-sync -- restore-asset-state

CHINA_PUBLICATION_ASSET_GENERATION="$(node scripts/china-publication-snapshot.js freeze)"
export CHINA_PUBLICATION_ASSET_GENERATION
echo "[china] frozen publication asset generation: $CHINA_PUBLICATION_ASSET_GENERATION"

# Local observation batches are the crash-safe handoff between probing and
# application. They are consumed once and cleaned up locally after the resulting
# persistent state is saved. Raw observations are never uploaded to B2.
# Stable is discovery input only. Rebuild the local candidate schedule every
# cycle from the persistent China asset pool plus the current Stable discovery
# feed. The B2 candidate file is an exported runtime artifact, not a lock or
# once-only work queue. Known China assets must continue to be maintained even
# when the B2 candidate file has the same generatedAt as the previous cycle.
npm run --silent china-sync -- pull-stable || echo 'Global Stable unavailable; continuing from persistent China state.'
npm run --silent china-sync -- pull-discovery-queue || true
npm run --silent china-assets
npm run --silent china-probe
npm run --silent china-apply

# Pair exploration is intentionally paused while the ordinary China exit
# pool is sufficient. Keep all Pair code, knowledge and published outputs;
# consume any already-produced Pair observations, but do not schedule or run
# new Pair probes. Set CHINA_PAIR_EXPLORATION=1 to resume the experiment.
export CHINA_PAIR_EXPLORATION="${CHINA_PAIR_EXPLORATION:-0}"
if [ "$CHINA_PAIR_EXPLORATION" = "1" ]; then
  npm run --silent china-relay-candidates
  npm run --silent china-relay-probe
fi
npm run --silent china-pair-apply

# From this point onward the China machine owns the entire state transition.
# No GitHub workflow is needed to apply observations or derive the next feed.
npm run --silent china-assets
if [ "$CHINA_PAIR_EXPLORATION" = "1" ]; then
  npm run --silent china-relay-candidates
fi
# Subscription generation is pinned to the pre-run snapshot. Current-cycle
# observations have already been applied to live state, but cannot affect this
# cycle's client.yaml or its component subscriptions.
export CHINA_ASSET_FILE="$CHINA_PUBLICATION_SNAPSHOT_DIR/china-node-assets.json"
export CHINA_PAIR_KNOWLEDGE_FILE="$CHINA_PUBLICATION_SNAPSHOT_DIR/china-pair-knowledge.json"
export CHINA_STICKY_STATE_FILE="$CHINA_PUBLICATION_SNAPSHOT_DIR/china-sticky.json"
npm run --silent china-pairs
npm run --silent china-pools
npm run --silent china-elite
npm run --silent china-sticky
npm run --silent client-config

# Diagnostics describe both the latest observation state and the older frozen
# publication inputs. Keep sticky selection state pinned to the same snapshot.
export CHINA_ASSET_FILE="$ORIGINAL_CHINA_ASSET_FILE"
export CHINA_PAIR_KNOWLEDGE_FILE="$ORIGINAL_CHINA_PAIR_KNOWLEDGE_FILE"
npm run --silent china-diagnostics

# Persist the continuity state resulting from this successful snapshot-based
# publication. Do not update it before client generation and diagnostics succeed.
mkdir -p "$(dirname "$ORIGINAL_CHINA_STICKY_STATE_FILE")"
cp "$CHINA_PUBLICATION_SNAPSHOT_DIR/china-sticky.json" "$ORIGINAL_CHINA_STICKY_STATE_FILE"
export CHINA_STICKY_STATE_FILE="$ORIGINAL_CHINA_STICKY_STATE_FILE"

# Publish the completed state/results. release.json is uploaded last so the
# GitHub publisher only observes a completed China generation.
npm run --silent china-sync -- publish-results

# Keep the immutable snapshot if publishing failed (set -e exits before here),
# otherwise remove the local intermediate after its generation ID is recorded.
rm -rf -- "$CHINA_PUBLICATION_SNAPSHOT_DIR"

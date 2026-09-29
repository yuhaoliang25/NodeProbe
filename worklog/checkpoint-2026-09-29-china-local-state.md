# Checkpoint 2026-09-29 — China local state ownership / remove Global Best dependency

## Decision

China is being moved from a GitHub-Action-owned state machine to a China-machine-owned state machine.

GitHub Actions must no longer:

- restore China node/pair state;
- apply China observations;
- derive China candidates;
- derive China pools;
- save China state back to B2.

The China machine performs the complete state transition locally and publishes completed results to B2.

## China machine flow

```
B2 candidate feeds / Global Stable discovery input
        ↓
China machine
        ↓
probe
        ↓
apply observations locally
        ↓
China node asset + pair knowledge
        ↓
derive next candidates / pair candidates / pools / client config
        ↓
publish completed generation to B2
        ↓
release.json written last
        ↓
GitHub publish-only workflow
```

B2 is transport/storage; it is not the China state-transition engine.

## GitHub workflow

`.github/workflows/china.yml` is now publish-only.

It:

1. reads `nodeprobe-state/china/release.json`;
2. downloads the completed China subscription/config outputs;
3. commits the published outputs to `main`.

It does not read or write China asset/pair state.

The workflow remains scheduled hourly for now because publication is read-only with respect to China state.

## Release marker

`nodeprobe-state/china/release.json` is uploaded last by `china-b2-sync.js publish-results`.

This gives the publisher a completion boundary: a new release marker means the China machine has already uploaded the corresponding state/results.

## China cycle

`scripts/china-cycle.sh` now:

- flushes pending observation batches;
- pulls Stable only as discovery input;
- consumes candidate feeds;
- probes locally;
- applies observations locally;
- derives China state/pair candidates/pools locally;
- publishes the completed result to B2.

The local China state is authoritative.

## Global Best dependency removed

China pair generation no longer uses `subscriptions/best.yaml`.

`scripts/build-china-relay-candidates.js` now derives both sides of pair candidates from China-owned assets:

- relay: reachable from China, direct exit weak;
- landing: China-owned asset with recent successful direct exit.

Global Best membership, score, or history is not used.

Global Stable remains only an external discovery/bootstrap input. The one-time Global→China cold-start injection has already been completed; it is not an ongoing Global→China state propagation mechanism.

## Why this change

Global currently may produce empty Stable/Best outputs. China therefore needs to solve its own direct and pair evolution without depending on Global Best.

More importantly, the previous GitHub workflow could race with the China machine:

```
old observation/state
       ↓
GitHub workflow
       ↓
new derived state

while China machine
       ↓
new observation
       ↓
different derived state
```

The new design removes GitHub from that state transition.

## Recovery / rollback

Before the China cold-start migration, rollback checkpoint:

`checkpoint/pre-china-cold-start-2026-09-23`

Current migration commits:

- `f7bba722a0bdfe92ae7bd5d74175d6e472b1ba4a` — China B2 publish/release mechanism
- `ff2bf8930f7f42ff4632b124e2f01731aaa8276d` — local China state evolution
- `e407560aebb81daae5dac8c1e0aefb2e9a51a35d` — China-only pair candidate inputs
- `10e73378595fc3614b710fbe07a462d87d092c62` — remove obsolete Global Best helpers
- `e2cfbfc7bf34de77073b47ccdf352b6b1437353c` — architecture documentation

If the migration causes unexpected behavior, the cold-start feed can be regenerated/reinjected. Global Node Pool is independent and is not modified by this China migration.

## Next observation

Do not optimize thresholds immediately.

First verify:

1. China machine can complete a full local cycle.
2. B2 receives state and release marker.
3. GitHub publishes the corresponding release without modifying China state.
4. Pair candidates continue to evolve when Global Best is empty.
5. No GitHub run can overwrite China asset/pair history.

Date: 2026-09-29

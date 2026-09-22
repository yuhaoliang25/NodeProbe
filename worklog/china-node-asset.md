# China Node Asset and Evolution

## 1. Boundary

China-side node state is an independent asset and trust system.

Its only production input in the first implementation is the current `subscriptions/stable.yaml` candidate pool.

It must not read or inherit:

- `data/reputation.json`;
- Global node reputation;
- Global node lifecycle;
- Global Best membership;
- Global success-rate or latency scores.

The Global Stable pool is treated as a capability filter, not as China trust.

## 2. Identity

A node is identified by the same deterministic endpoint identity used by NodeProbe's global endpoint identity scheme. The identity is used only to correlate the same endpoint across the two systems.

Identity correspondence does not transfer trust.

China records its own observation history from the moment the China probe first sees the endpoint.

## 3. China Asset

The persistent China asset contains, per endpoint:

- `endpointId`
- `firstObservedAt`
- `lastObservedAt`
- `observedRuns`
- `successes`
- `failures`
- `recentSuccesses`
- `recentFailures`
- `successStreak`
- `failureStreak`
- `lastSuccessAt`
- `lastFailureAt`
- `lastProbeAt`
- `state`
- `deadSince` when applicable
- `nextProbeAt`
- `recheckLevel`

The last field records why the endpoint was admitted to the China candidate set. It is not China trust.

## 4. Observation Semantics

All timestamps mean **China Probe observation times**.

They do not mean:

- first publication time;
- source update time;
- GitHub commit time;
- actual node creation time.

An observation belongs to a specific probe environment. The same China asset format can later support multiple environments without claiming that one machine represents all of China.

## 5. Lifecycle

Initial lifecycle:

```
NEW
 ↓
PROBATION
 ↓
TRUSTED
 ↓
DEGRADED
 ↓
UNTRUSTED
 ↓
FORGOTTEN
```

The state is derived from China evidence only.

Initial transition policy:

- NEW: no successful observation yet.
- PROBATION: at least one successful observation, but insufficient evidence for trust.
- TRUSTED: at least 5 observations and recent success rate >= 0.90, with no current failure streak.
- DEGRADED: a previously trusted node has accumulated 2 consecutive failures, or recent success rate falls below 0.70.
- UNTRUSTED: 6 consecutive failures, or a degraded/probation node has persistent recent failure.
- FORGOTTEN: UNTRUSTED retention expires after scheduled rechecks fail to produce recovery evidence.

These thresholds are initial operational parameters, not claims that they are optimal.

## 6. Evolution

China state survives changes in the current Stable pool.

If an endpoint disappears from Stable:

- do not delete its China asset;
- do not reset its China trust;
- simply exclude it from the next candidate set unless policy later permits historical recovery probing.

If it returns to Stable:

- reuse the existing China asset;
- continue its China lifecycle;
- do not treat it as a new node.

A temporary China probe failure is evidence about the China dimension, not evidence that the endpoint is globally dead.

## 7. Sampling

Each probe run uses a bounded budget.

Candidate classes:

1. NEW / unknown;
2. trusted nodes that have not yet reached veteran evidence;
3. trusted veterans due for retest;
4. recently failed nodes due for retry;
5. forgotten nodes on long-interval recovery recheck.

Priority is dynamic rather than a permanent percentage split.

A veteran is never exempt from testing. It receives priority when its maximum retest interval expires.

The first implementation uses:

- max 30 nodes per run;
- veteran retest interval: 24h;
- failed retry cooldown: 2h;
- forgotten recovery retry interval: 7d;
- newly admitted nodes get priority for early evidence.

The exact numbers are tunable later from observation data.

## 8. Recovery

A trusted node does not lose all historical value after one failure.

A failure moves it into revalidation/degraded handling according to its failure streak.

An untrusted node does not recover from one success. It must accumulate successful observations again.

After repeated failed rechecks, an endpoint may enter `FORGOTTEN`. Forgotten assets are retained in persistent state but leave the normal frequent probe loop. They are eligible for a long-interval recovery recheck while they remain in the Stable candidate pool.

A successful forgotten-node recheck returns it to `PROBATION`; historical counters are retained rather than reset.

This prevents both:

- one transient failure from destroying a veteran;
- one lucky success from promoting a historically unreliable endpoint;
- permanently consuming probe budget on endpoints with persistent failure.

## 9. Roles

China trust produces a reachability set `R`.

With:

- `S` = current Global Stable set;
- `B` = current Global Best set;
- `R` = China trusted/reliably reachable set;

derived roles are:

- Relay-only = `S ∩ R - B`
- Landing = `B - R`
- Direct = `B ∩ R`

Relay is a derived role, not a permanent China lifecycle state.

## 10. Non-goals

The first China implementation does not:

- calculate Relay × Landing combinations;
- search for a globally optimal pair;
- copy Global reputation into China;
- maintain a permanent pair matrix;
- claim universal reachability across China;
- optimize candidate count.

The client is responsible for current-path selection.

## 11. Core Invariants

1. Stable is input capability evidence, not China trust.
2. China trust comes only from China observations.
3. Global and China histories are independently evolvable.
4. Node disappearance from Stable is not China death.
5. Veteran nodes must be retested.
6. Historical trust is retained until China evidence changes it.
7. Detailed China history must eventually have bounded retention.
8. Relay/Landing roles are derived views, not permanent identities.

## 12. Observation Apply Boundary

The China asset updater consumes observations produced by the China-side probe environment. It does not perform network tests itself and does not consult Global reputation.

The observation boundary is:

```
China Probe Agent
  ↓
China observations
  ↓
apply-china-observations
  ↓
China Node Asset
```

An observation contains an endpoint identity, observation time, success/failure, optional latency, optional error category, and probe-environment identifier.

The updater applies observations only to the China asset history. It never modifies Global node reputation.

This separation allows the probe implementation to evolve independently from the asset state machine and makes replay/testing of observations possible.

## 13. Current Implementation Boundary

The first implementation intentionally has three independent steps:

1. read the current Global Stable pool and select China candidates;
2. run a China-side probe and produce observations;
3. apply observations to the persistent China asset.

Network probing is not simulated by the GitHub-side asset updater. A future China-side agent should own the actual China-to-node measurement.


## 14. Pool Derivation Implementation

The first pool derivation uses the persistent China asset state and current Global Stable/Best pools.

Let:

- S = current Global Stable;
- B = current Global Best;
- R = China assets currently in TRUSTED state.

The generated pools are:

- direct.yaml = B ∩ R;
- relay.yaml = S ∩ R - B;
- landing.yaml = B - R.

These are views derived from current state. They do not mutate China trust and do not create Relay/Landing lifecycle states.

The derivation is implemented by scripts/build-china-pools.js and exposed as npm run china-pools.

The client configuration layer consumes these three pools. It is intentionally separate from China asset evolution so that pool policy can change without rewriting historical China observations.


## 15. China Probe Transport

China Probe transport uses Backblaze B2 as an asynchronous inbox/outbox rather than a mutable observation file.

The NodeProbe side publishes the candidate feed under `nodeprobe-state/china/candidates.json`.

The China-side agent pulls that feed, probes the selected endpoints, and writes immutable observation batches under `nodeprobe-state/china/observations/<environment>/...`.

A batch is never overwritten by a later probe run. `apply-china-observations` is idempotent, so replaying an already consumed batch does not duplicate evidence.

The repository includes `scripts/china-b2-sync.js` for the local China machine:

- `npm run china-sync -- pull-candidates`
- `npm run china-sync -- push-observations`

The transport helper uses the Backblaze B2 CLI (`b2v4`) and credentials supplied through environment variables; credentials are not stored in the repository.

This transport is intentionally asynchronous. GitHub does not initiate inbound connections to the China machine, and the China machine does not need to expose a public service.


## 16. China Observation Inbox Consumer

The NodeProbe workflow now consumes the China observation inbox before deriving the next China candidate set.

Flow:

```
B2 observation inbox
  ↓
GitHub workflow download
  ↓
apply-china-observations
  ↓
China asset evolution
  ↓
next candidate selection
```

Observation batches are immutable. The China asset state records a bounded list of processed batch names in `processedObservationBatches`, while individual observations are also deduplicated by deterministic observation ID. Therefore a workflow retry or repeated inbox download does not duplicate China evidence.

The workflow deliberately applies observations **before** saving the updated China asset state. This keeps the persistent B2 asset and the candidate feed consistent with the observations consumed by that run.

The same existing B2 application key is used for the China transport. No separate credential is introduced at this stage. On the user's own China machine, the key is supplied through the environment and never committed to the repository.

The China-side upload helper deletes a local observation batch only after the upload command succeeds. The immutable copy in B2 remains the transport record.

This is an asynchronous pull/push protocol: the China machine never needs an inbound service, and GitHub never needs to initiate a connection to it.

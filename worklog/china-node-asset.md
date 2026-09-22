# China Node Asset and Trust Architecture

> Internal design note for the China-side node system. This system is intentionally decoupled from Global NodeProbe reputation.

## 1. Purpose

The China-side system answers: can this endpoint currently serve as a usable entry/relay node from this China probe environment, and how much should the China system trust that observation?

The same endpoint may therefore have two independent assets:

```
endpoint X
  ├── Global Node Asset → Global history / trust / Stable / Best
  └── China Node Asset  → China observations / trust / lifecycle
```

## 2. Hard Independence Invariant

China trust MUST NOT be imported from Global reputation. Global success rate, latency, trust, Stable/Best status, failure history, and lifecycle must not directly update China trust. China observations must not update Global reputation.

The endpoint identifier may correspond across the systems, but the evidence attached to that identity belongs to the corresponding system.

Thus this is valid:

```
Global: E123 → trusted
China:  E123 → untrusted
```

## 3. Stable Is a Capability, Not Trust

China may use Global Stable as a computational shortcut. Its meaning is narrow: Global validation has previously shown that the endpoint possesses basic proxy functionality under the Global probe environment.

```
Global Stable
     │ capability evidence only
     ↓
China probe candidate
```

Stable MUST NOT imply China trusted.

This is an explicit candidate-reduction assumption: if an endpoint cannot satisfy the Global Stable proxy-function test, proving that it is reachable from China does not make it useful as a proxy/relay.

## 4. Stable Evidence Is Evidence About Admission, Not China Trust

The China asset may record when and why Global Stable was used to admit an endpoint into the China candidate universe, for example globalStableObservedAt and a run/evidence reference.

These fields explain candidate admission. They are not China trust fields.

If Global later loses Stable status, China trust is not automatically changed. Any future removal from the China candidate universe is a separate candidate-policy decision.

## 5. China Node Asset

China maintains its own persistent node record. A conceptual record is:

```json
{
  "endpointId": "...",
  "firstObservedAt": "...",
  "lastObservedAt": "...",
  "observedRuns": 0,
  "currentState": "new",
  "historicalTrust": "untrusted",
  "successes": 0,
  "failures": 0,
  "recentSuccesses": 0,
  "recentFailures": 0,
  "successStreak": 0,
  "failureStreak": 0,
  "lastSuccessAt": null,
  "lastFailureAt": null,
  "lastProbeAt": null
}
```

The exact field names are implementation details. The separation of responsibilities is architectural.

## 6. Observation Model

China evidence is modeled as:

Node × Probe Environment × Time

An observation should record endpoint identity, observation time, probe environment/version, success/failure, latency when successful, and failure category when available.

One China-side machine is not universal evidence for every Chinese ISP, city, carrier, or network. Prefer the semantic phrase 'reachable from this China probe environment'.

## 7. China Trust and Evolution

China trust is built only from China observations. Its states do not have to match the Global lifecycle.

```
NEW → PROBATION → TRUSTED
                  ↓
              DEGRADED
                  ↓
              UNTRUSTED
```

A trusted China node should tolerate an isolated failure because of its accumulated China evidence. An untrusted node should not become trusted after one success; it needs a defined recovery sequence. These are China-side evidence rules, not imports from Global reputation.

## 8. Persistent Evolution

The China asset must survive individual probe runs. Temporary failure or disappearance from the current reachable set does not immediately delete the node.

Example:

```
run 1 PASS → run 2 PASS → run 3 PASS → run 4 FAIL → run 5 FAIL → run 6 PASS
```

remains one continuous China history.

The system should distinguish newly observed, currently reachable, intermittently reachable, historically reliable, temporarily failing, persistently failing, and forgotten.

## 9. Veterans

A long-term reliable China node is a valuable asset but is never permanently exempt from testing. Veterans receive retest priority because China-side network conditions can change independently of the endpoint.

Historical trust therefore means accumulated evidence, not immunity.

## 10. Candidate Sampling

The China probe should not test every endpoint on every run. Global Stable reduces the candidate universe by providing basic proxy-capability evidence.

Within the candidate universe, priority should generally go to:

1. newly admitted/unknown China nodes;
2. current China-relay nodes;
3. veterans due for retest;
4. recently failed nodes due for retry.

Use quotas plus priority rather than permanently fixed percentages. Initial numbers are implementation parameters and should be tuned from observed data.

## 11. Relay Is a Derived Role

Relay should not become a permanent trust flag. It is derived from current Global candidate membership plus China evidence.

```
Global capability
      ↓
China observation history
      ↓
China trusted/reachable
      ↓
Relay role
```

This allows an endpoint to enter and leave the Relay pool without changing its underlying historical identity.

## 12. Separation From Landing Quality

Stable, Best, and China Trust represent different dimensions:

```
Stable      = basic proxy capability under Global validation
Best        = stricter Global quality / landing-oriented selection
China Trust = observed usability from the China probe environment
```

Therefore Global Best + China unreachable, Global Stable + China trusted, and Global Best + China trusted are all coherent states.

## 13. Pool Derivation

Let S be Global Stable, B be Global Best, and R be endpoints currently trusted/reliably reachable by the China system.

```
Relay-only = S ∩ R - B
Landing    = B - R
Direct     = B ∩ R
```

These are derived roles, not a merged reputation system.

## 14. No Pairwise Optimization

NodeProbe should not maintain a permanent Relay × Landing matrix or attempt to calculate a globally optimal pair.

The relevant path is:

China → Relay → Landing → Target

Only the consuming client observes this complete path under its own network conditions. NodeProbe therefore publishes candidate pools and evidence; the client performs current-path selection.

## 15. Storage Boundary

China runtime state is persistent but should stay outside Git, for example:

```
B2
 ├── china-node-assets.json
 ├── china-node-history.json
 └── China probe metadata/history
```

Temporary diagnostic artifacts may expose a safe node-centric view to maintainers.

## 16. Non-Goals

China must not copy Global reputation, add Global success rates to China trust, mark a node trusted because it is Global Best, mark a node untrusted because Global reputation degraded, maintain a permanent relay flag, exhaustively test Relay × Landing pairs, treat one probe as universal China evidence, or permanently exempt veterans from testing.

## 17. Core Invariants

1. The same endpoint may have different trust in the two systems.
2. Global Stable is capability evidence, not China trust.
3. China trust is derived only from China observations.
4. Global trust is derived only from Global observations.
5. Historical China assets survive temporary absence/failure.
6. Veterans are periodically retested.
7. Relay/Direct/Landing are derived roles, not a third reputation system.
8. No permanent Relay × Landing optimization matrix is maintained.
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

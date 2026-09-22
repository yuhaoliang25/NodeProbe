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


## 17. China Probe Deployment and Parallelism

The China-side probe is intended to run as a local systemd timer rather than as an inbound service.

Deployment files:

- systemd/nodeprobe-china.service
- systemd/nodeprobe-china.timer
- scripts/china-cycle.sh

One cycle performs:

1. pull the latest candidate feed;
2. run the China probe;
3. push immutable observation batches.

The timer runs approximately every 30 minutes, with a small randomized delay. A persistent timer ensures a missed scheduled run can be triggered after the machine returns online.

The probe itself uses bounded concurrency (CHINA_PROBE_CONCURRENCY, default 8) instead of serially waiting for every node. Results are stored by candidate index so concurrency does not alter candidate identity or observation semantics. The concurrency value is intentionally configurable because the local network and machine may have different practical limits.

The probe remains bounded by the China candidate budget (CHINA_MAX_NODES, default 30). Parallelism is an execution optimization only; it does not change China trust rules, candidate scoring, or lifecycle transitions.

The deployment uses the existing B2 credentials supplied through ~/.config/nodeprobe/china.env. No credential is committed to the repository.


## 18. China Probe Machine Deployment Guide

### 18.1 Prerequisites

The China-side machine needs:

- Node.js 22 or newer;
- npm;
- a working Mihomo binary available as `mihomo`, or `MIHOMO_BIN` pointing to it;
- the `b2v4` command;
- network access to Backblaze B2;
- the NodeProbe repository checked out from `main`.

The machine does not need to accept inbound connections from GitHub. Communication is asynchronous through B2.

### 18.2 B2 credentials

Create `~/.config/nodeprobe/china.env` and keep it readable only by the local user:

```ini
B2_APPLICATION_KEY_ID=YOUR_EXISTING_KEY_ID
B2_APPLICATION_KEY=YOUR_EXISTING_KEY
CHINA_B2_BUCKET=nodeprobe
CHINA_B2_PREFIX=nodeprobe-state/china
CHINA_PROBE_ENV=china-home
CHINA_MAX_NODES=30
CHINA_PROBE_CONCURRENCY=8
CHINA_PROBE_TIMEOUT=8000
```

The existing NodeProbe B2 credentials may be reused for the user's own machine. Credentials must never be committed to the repository.

```bash
mkdir -p ~/.config/nodeprobe
chmod 700 ~/.config/nodeprobe
chmod 600 ~/.config/nodeprobe/china.env
```

### 18.3 First manual test

Before enabling systemd, run one complete cycle manually:

```bash
cd ~/NodeProbe
set -a
source ~/.config/nodeprobe/china.env
set +a
npm install
npm run china-sync -- pull-candidates
npm run china-probe
npm run china-sync -- push-observations
```

Verify that `data/china-probe-candidates.json` was downloaded, the probe generated an observation file and an immutable batch under `data/china-probe-observations/`, and the batch appeared under the B2 China observation prefix.

### 18.4 systemd installation

The repository provides:

- `systemd/nodeprobe-china.service`
- `systemd/nodeprobe-china.timer`
- `scripts/china-cycle.sh`

Install them:

```bash
mkdir -p ~/.config/systemd/user
cp ~/NodeProbe/systemd/nodeprobe-china.service ~/.config/systemd/user/
cp ~/NodeProbe/systemd/nodeprobe-china.timer ~/.config/systemd/user/
systemctl --user daemon-reload
```

Run the service once before enabling the timer:

```bash
systemctl --user start nodeprobe-china.service
systemctl --user status nodeprobe-china.service
journalctl --user -u nodeprobe-china.service -n 100 --no-pager
```

After a successful manual service run:

```bash
systemctl --user enable --now nodeprobe-china.timer
systemctl --user status nodeprobe-china.timer
systemctl --user list-timers | grep nodeprobe-china
loginctl enable-linger "$USER"
```

The timer runs approximately every 30 minutes, with a small randomized delay. `Persistent=true` allows a missed run to be triggered after the machine returns online.

### 18.5 Runtime flow

Each cycle is:

```text
B2 candidates
    ↓
pull-candidates
    ↓
China Probe / Mihomo
    ↓
immutable observation batch
    ↓
push-observations
    ↓
B2 observation inbox
    ↓
GitHub Actions
    ↓
China Asset evolution
```

The China machine never pushes directly into the Git repository and never needs an inbound endpoint.

### 18.6 Performance configuration

The probe is bounded to `CHINA_MAX_NODES` candidates per cycle and uses bounded parallelism through `CHINA_PROBE_CONCURRENCY`. The default is 30 nodes and 8 concurrent probes.

A higher concurrency can reduce wall-clock time but may increase local bandwidth, connection pressure or target-side rate limiting. Adjust it only after observing real runtime behavior.

### 18.7 Troubleshooting

Check timer:

```bash
systemctl --user status nodeprobe-china.timer
systemctl --user list-timers | grep nodeprobe-china
```

Check the latest service run:

```bash
systemctl --user status nodeprobe-china.service
journalctl --user -u nodeprobe-china.service -n 200 --no-pager
```

Check B2 credentials:

```bash
b2v4 account authorize
```

Check candidate feed:

```bash
cat data/china-probe-candidates.json
```

Check probe results:

```bash
cat data/china-probe-observations.json
ls -lh data/china-probe-observations/
```

If candidates cannot be pulled, investigate B2 credentials, bucket/prefix configuration and network access before changing China trust logic.

If Mihomo fails, run `mihomo -v` and verify `MIHOMO_BIN`.

If the probe is slow, inspect `CHINA_PROBE_CONCURRENCY` and `CHINA_PROBE_TIMEOUT` before changing candidate selection.

### 18.8 Upgrade procedure

Stop the timer before upgrading the checkout:

```bash
systemctl --user stop nodeprobe-china.timer
cd ~/NodeProbe
git pull --ff-only origin main
npm install
systemctl --user daemon-reload
systemctl --user start nodeprobe-china.service
systemctl --user enable --now nodeprobe-china.timer
```

Do not remove `data/china-node-assets.json` on the NodeProbe/GitHub side merely because the China machine is upgraded; China historical trust is persistent state and is intentionally independent of the machine's local runtime files.


## 20. Staged China Detection

China Probe now follows a staged detection pipeline instead of treating one delay request as the complete China test.

```text
Global Stable
    ↓
China candidate selection
    ↓
China Stage 1 — fast screening
    ↓
Stage 1 retry — failed/timeout recovery
    ↓
China Stage 2 — normal-timeout confirmation
    ↓
China Deep — repeated rounds
    ↓
one final observation per node/run
    ↓
China Asset
```

The stages are **detection evidence**, not separate China trust states.

Stage attempts are retained in the immutable observation batch for diagnosis, while only one final observation per node per probe run is applied to the persistent China asset. This is important: five stages in one run must not artificially count as five independent historical China observations.

The reusable execution primitives live in `scripts/lib/probe-runner.js`. They provide common bounded-concurrency execution and Mihomo delay probing. This is the first step toward sharing mature Global detection mechanisms without sharing Global reputation.

Current China-specific controls include:

- `CHINA_STAGE1_TIMEOUT` (default 5000 ms);
- `CHINA_PROBE_TIMEOUT` (default 8000 ms);
- `CHINA_DEEP_ROUNDS` (default 2);
- `CHINA_PROBE_CONCURRENCY` (default 8).

The stage structure is intentionally configurable. Future work can add multi-target stability confirmation using the same reusable detection primitives and the methodology already used by Global `confirm-stability.js`.

The architectural rule remains:

> Reuse detection mechanisms; isolate evidence and conclusions.


## 19. Detection Mechanism Reuse Across Global and China

Global and China must keep their **evidence, asset state, reputation, and conclusions independent**, but they should not duplicate detection engineering unnecessarily.

The separation is therefore:

```text
Detection mechanism
        │
   ┌────┴────┐
   │         │
Global    China
probe     probe
   │         │
Global    China
evidence  evidence
   │         │
Global    China
reputation/asset
```

### 19.1 What may be reused

Detection mechanisms are reusable when their semantics do not depend on the probe location. Examples include:

- bounded concurrency;
- request timeout and retry handling;
- multi-round testing;
- target randomization;
- success/failure accounting;
- latency and p95 calculation;
- consecutive failure/timeout tracking;
- stability confirmation;
- per-attempt traces;
- run-level summaries;
- deterministic result ordering;
- bounded probe budgets.

Global's later-stage testing, including the general ideas used by Stage 2, deep rounds, and stability confirmation, should therefore be treated as reusable **detection methodology**, not as Global reputation logic.

### 19.2 What must remain independent

The following must never be copied from Global into China merely because the detection mechanism is reused:

- Global node reputation;
- Global health history;
- Global stability result;
- Global Best membership;
- Global lifecycle state;
- Global trust thresholds as an automatic China trust decision.

A Global observation is evidence about the Global probe environment. A China observation is evidence about the China probe environment.

Thus:

```text
Global stability = evidence of stability from Global environment
China stability  = evidence of stability from China environment
```

The same algorithm may calculate both, but the observations and conclusions belong to different assets.

### 19.3 Probe environment is a first-class dimension

The meaningful abstraction is:

```text
Node × Probe Environment × Time → Observation
```

The probe environment includes at least the execution location/environment, probe version, test targets and relevant configuration.

This prevents the system from treating a successful Global test as universal reachability. A node may be stable from GitHub's environment while unstable or unreachable from a China machine, and the reverse can also occur.

### 19.4 China should evolve beyond single-shot probing

The current China probe is intentionally simple. It should not become permanently defined as:

```text
Stable candidate → one delay request → China trust
```

A future China detection pipeline may progressively adopt the same staged structure used by Global:

```text
Global Stable candidate
        ↓
China Stage 1
        ↓
China Stage 2
        ↓
China Deep / multi-round testing
        ↓
China Stability Confirmation
        ↓
China observation evidence
        ↓
China asset / trust state
```

The exact stages, targets, budgets and thresholds should be tuned from China-side observations rather than copied blindly from Global.

### 19.5 Architecture principle

The long-term design principle is:

> **Reuse detection mechanisms; isolate evidence and conclusions.**

Global and China should share engineering primitives and testing methodology where semantics permit, while maintaining independent observation histories, trust models, lifecycle states and output pools.

This avoids two opposite mistakes:

1. duplicating mature detection code merely because the probe environments differ;
2. incorrectly transferring Global test results into China trust merely because the same node passed Global tests.

## 21. China Stability Confirmation

China now also reuses the common stability engine after the China Deep rounds. The current flow is:

```text
Stage 1
  ↓
Stage 2
  ↓
Deep rounds
  ↓
China Stability Confirmation
  ├─ Google 204
  ├─ Cloudflare trace
  └─ GitHub
  ↓
one final China observation per node/run
```

The stability mechanism is shared with Global through `scripts/lib/probe-stability.js`, but the execution remains on the China machine and the result is stored only as China evidence.

Current default China stability configuration is intentionally conservative but provisional: 3 rounds, 6 attempts per target in total, 5 s stability timeout, at least 90% overall success, at least 67% per-target and per-round success, p95 <= 5 s, and at most one consecutive failure or timeout. These values are configuration, not a claim that Global and China should have identical thresholds.

A node that reaches Deep but fails China Stability Confirmation produces a failed final China observation for that probe run. Its detailed stability attempts remain in the immutable observation batch, allowing later threshold analysis without treating the node as permanently dead.

Most importantly, this is still not Global Best/Stable logic copied into China. The same measurement engine is reused; the China environment, observations, history and asset state remain independent.

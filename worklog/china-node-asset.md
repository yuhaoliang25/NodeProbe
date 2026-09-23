# China Node Asset and Evolution

## 1. Boundary

China-side node state is an independent asset and trust system.

Its discovery input is the current `subscriptions/stable.yaml` feed. The persistent China asset pool is independent and remains the authority for China maintenance.

It must not read or inherit:

- Global Node Pool state;
- Global node lifecycle;
- Global Best membership;
- Global node health history or scores;
- any Global Node trust/lifecycle conclusion.

It may consume only the published `subscriptions/stable.yaml` feed as a baseline/discovery input. Stable membership is an input boundary, not transferred China trust.

Global Stable is an exploration/discovery feed, not a China asset-membership filter and not China trust.

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

`nextProbeAt` is the persisted maintenance schedule and is the primary due-time field. The candidate builder uses it directly when valid; it falls back to the legacy `lastProbeAt`-based interval calculation only for older state files that do not yet contain a valid schedule.

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
- DEGRADED: a previously trusted node has accumulated 2 consecutive failures, or recent success rate falls below 0.70. It remains DEGRADED until it records 3 consecutive successful observations, then returns to PROBATION for further evidence.
- UNTRUSTED: 6 consecutive failures.
- FORGOTTEN: UNTRUSTED retention expires after scheduled rechecks fail to produce recovery evidence.

These thresholds are initial operational parameters, not claims that they are optimal.

## 6. Evolution

China state survives changes in the current Stable pool.

If an endpoint disappears from Stable:

- do not delete its China asset;
- do not reset its China lifecycle;
- continue maintenance according to the persistent China asset's own schedule, using its stored proxy definition.

If it returns to Stable:

- refresh the stored proxy definition when the endpoint identity matches;
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

Priority is dynamic rather than a permanent percentage split. Due maintenance assets are selected before newly discovered Stable entries, so a large or rapidly changing Stable feed cannot starve the persistent China pool.

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

An untrusted or forgotten node does not recover directly from one success. The first successful recovery observation returns it to PROBATION, so its recent historical rate cannot immediately promote it to TRUSTED. It must accumulate fresh successful observations again.

After repeated failed rechecks, an endpoint may enter `FORGOTTEN`. Forgotten assets are retained in persistent state but leave the normal frequent probe loop. They are eligible for a long-interval recovery recheck from the persistent China asset pool.

A successful forgotten-node recheck returns it to `PROBATION`; historical counters are retained rather than reset.

This prevents both:

- one transient failure from destroying a veteran;
- one lucky success from promoting a historically unreliable endpoint;
- permanently consuming probe budget on endpoints with persistent failure.

## 9. Roles

China trust produces a reachability set `R`.

The production direct pool is derived from China assets only:

- Direct = China assets in `TRUSTED` state with a stored proxy definition.

The relay/landing pair experiment is separate:

- Relay candidates = China assets whose latest China reachability is good and whose direct exit is weak.
- Landing candidates = Global Best nodes that are not already China Trusted/direct-capable.

These are derived experimental roles, not permanent China lifecycle states.

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

The China asset updater consumes observations produced by the China-side probe environment. It does not perform network tests itself and does not consult Global Node Pool state or Global Node lifecycle state.

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

The updater applies observations only to the China asset history. It never modifies Global Node Pool state or Global Node lifecycle.

This separation allows the probe implementation to evolve independently from the asset state machine and makes replay/testing of observations possible.

## 13. Current Implementation Boundary

The first implementation intentionally has three independent steps:

1. read the current Global Stable feed to discover new endpoints and refresh known endpoint definitions;
2. select due maintenance assets plus newly discovered endpoints into the bounded China candidate feed;
3. run a China-side probe and produce observations;
4. apply observations to the persistent China asset.

Network probing is not simulated by the GitHub-side asset updater. A future China-side agent should own the actual China-to-node measurement.


## 14. Pool Derivation Implementation

The production direct pool is derived entirely from the persistent China asset state.

Let:

- R = China assets currently in TRUSTED state and carrying a stored proxy definition.

The generated production pool is:

- direct.yaml = R.

Relay/landing are experimental pair-candidate views and are not generated as production China pools.

The derivation is implemented by scripts/build-china-pools.js and exposed as npm run china-pools.

The client configuration layer consumes the resulting production and experimental outputs separately. Pool policy can therefore change without rewriting historical China observations.


## 15. China Probe Transport

China Probe transport uses Backblaze B2 as an asynchronous inbox/outbox rather than a mutable observation file.

The NodeProbe side publishes the current Global Stable pool under `nodeprobe-state/china/stable.yaml` and the bounded China candidate feed under `nodeprobe-state/china/candidates.json`.

The GitHub-side China workflow pulls `stable.yaml` from B2 as the discovery feed before building the next bounded candidate set. The China-side agent then pulls only the candidate feed and probes exactly those candidate assets; the probe does not consult Stable. It writes immutable observation batches under `nodeprobe-state/china/observations/<environment>/...`.

A batch is never overwritten by a later probe run. `apply-china-observations` is idempotent, so replaying an already consumed batch does not duplicate evidence.

The repository includes `scripts/china-b2-sync.js` for the local China machine:

- `npm run china-sync -- pull-stable`
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
China asset candidate → bounded staged probe → China observation → lifecycle update
```

A future China detection pipeline may progressively adopt the same staged structure used by Global:

```text
China asset candidate
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


## 22. Direct-first China Probe Architecture

The China design was revised after separating the question of **China-side reachability** from the question of **end-to-end proxy performance**.

The production objective is now:

> Find nodes that can be directly used from the China probe environment. Relay combinations are an experimental fallback, not the definition of the China pool.

### 22.1 Two different measurements

A China probe must distinguish:

```text
China → Node
```

from:

```text
China → Node → Internet target
```

The first measures **China-side endpoint reachability**. It should not use a proxy to access Google. The current Stage 0 therefore performs a direct TCP connection to the node endpoint.

The second measures **actual direct proxy usability**. Mihomo is appropriate here because the desired measurement is the real path:

```text
China → Node → Target
```

The current China pipeline therefore starts with endpoint reachability and then applies the Mihomo-based direct proxy stages only to reachable candidates.

### 22.2 Production pool

The production China pool is now:

```text
China Trusted assets with stored proxy definitions
```

and is published as `subscriptions/direct.yaml`.

The previous Stable ∩ Trusted relay pool and Best - Trusted landing pool are no longer treated as production China roles. Relay/landing are now used only by the bounded experimental pair search described below.

This prevents the architecture from assuming that an additional relay hop is beneficial.

### 22.3 Why relay remains an experiment

For a relay A and landing B, a relay path can only outperform A's direct Internet path when, in simplified terms:

```text
cost(A → B) + cost(B → target)
    <
cost(A → target)
```

This is possible because Internet routing is destination- and path-dependent. A may have a poor path to a target while having an unusually good path to B, and B may have excellent connectivity to that target.

But this is a hypothesis to test, not an assumption to encode into the primary architecture.

A full relay search also introduces a combinatorial A×B problem. Therefore the production system should not pay that complexity unless direct China exits prove insufficient.

A future relay experiment may use a bounded heuristic:

```text
1. measure China-side direct reachability;
2. rank a small number of good relay candidates;
3. for each selected relay, test a bounded set of landing candidates;
4. compare China → A → B → target against China → A → target;
5. retain a relay only when the measured end-to-end result demonstrates a meaningful and repeatable gain.
```

This is an experiment, not an optimal-route solver.

### 22.4 Reuse boundary

Global detection modules can still be reused for **end-to-end proxy testing and generic measurement mechanics**.

They must not be reused as the semantic definition of China reachability.

The correct abstraction boundary is:

```text
Reusable:
- concurrency
- timeout
- retries
- attempt tracing
- multi-round execution
- latency statistics
- stability metrics

Environment-specific:
- China → Node reachability
- China → Node → target performance
- Global → Node → target performance

Independent:
- observations
- reputation
- asset state
- trust
- production pools
```

The architecture therefore favors reusable measurement primitives rather than a single universal probe meaning.

### 22.5 Direct admission is China Trusted assets

The production direct pool uses the persistent China assets that are currently `TRUSTED` and have a stored proxy definition.

Global Best is not required for China direct admission. Global Stable only supplies discovery information; China independently determines usability and lifecycle from China-side evidence.

This keeps the responsibilities separate:

```text
Global Stable → discovery / endpoint-definition evidence
China Probe   → China-side usability evidence
China Asset   → China lifecycle and persistent maintenance
```

A node therefore does not need to be Global Best merely to become a China direct node.

## 23. Bounded Relay Pair Experiment

Relay is now an explicit experiment rather than a production assumption.

The experiment asks whether a China-reachable node whose direct exit is weak can become useful when its outbound connection is established through a stronger Global Best landing node:

```text
China → A → Internet
versus
China → A → B → Internet
```

Here:

- A (relay) is selected from the persistent China asset population;
- A must have recent China reachability evidence but must currently fail the China direct admission result;
- only the top CHINA_RELAY_TOP_K relay candidates are used;
- B (landing) is selected from Global Best;
- China Trusted/direct-capable nodes are excluded from the landing set;
- the experiment is strictly two-hop; no A×B×C search is performed.

The default search budget is therefore bounded at:

```text
Top 8 relays × Top 30 landings = at most 240 pairs
```

The China machine performs a cheap Google screen over the bounded pair set. A pair is shortlisted only when:

1. the pair succeeds; and
2. it improves the relay's direct baseline by at least 15%, or succeeds when the baseline fails.

Only the best CHINA_PAIR_CONFIRM_TOP_K screen results are then confirmed against Google, Cloudflare and GitHub over multiple rounds. A pair enters the published experimental pool only after confirmation succeeds across the targets.

Mihomo implements the chain with dialer-proxy: the landing proxy B is configured to establish its connection through relay A.

### 23.1 Pair knowledge

Pair results are persisted separately from China node trust:

```text
data/china-pair-knowledge.json
        ↓
pair history
        ↓
recent success / improvement evidence
        ↓
subscriptions/pairs.yaml
```

The pair record is evidence, not permanent truth. A pair can disappear from the published experimental list when its evidence becomes stale or its recent improvement rate falls below the configured threshold.

This deliberately treats pair history as network-path evidence rather than an immutable property of the two endpoints. The endpoints can change even though their identities remain the same.

### 23.2 Client role

The generated client configuration places validated pair proxies and direct China proxies in the same URL-Test group.

Thus the final choice remains adaptive:

```text
China Probe:
    discover useful paths

Client:
    choose among Direct and validated Pair
    using the user's current network
```

The client is not asked to perform the combinatorial search. It only compares the small set of paths already discovered by the China probe.

### 23.3 Why this search is intentionally asymmetric

The search does not test Stable × Stable.

That would spend most of the budget testing pairs whose two endpoints already belong to the same candidate population.

Instead:

```text
Relay A = China asset ∩ China-reachable ∩ Direct-weak
Landing B = Best - China Direct-capable
```

This makes the experiment specifically target the hypothesis that a China-reachable but poor exit can gain a special path to a strong global exit.

The experiment does not assume that relaying is beneficial. A large number of failed pairs is itself useful evidence. The persistent pair history is intended to answer whether useful A/B path affinity repeatedly appears in this node population over time.

## 24. Current Deployment and Information-Flow Contract

This section is the current deployment contract. It supersedes earlier descriptions in §§9, 14, 17 and 18 where those sections still describe production Relay/Landing pools or a China cycle without the Pair experiment.

### 24.1 Production and experimental boundaries

Production China output is:
- `subscriptions/direct.yaml` = China Trusted assets with stored proxy definitions.
- `subscriptions/pairs.yaml` = validated two-hop paths from the separate Pair experiment.
- `mihomo/client.yaml` = client configuration that can compare Direct and validated Pair paths.

`relay.yaml` and `landing.yaml` are no longer production pools.

The Pair experiment is optional. If no Pair candidate feed exists, the China machine continues normal China-asset probing and the cycle succeeds without Pair testing.

### 24.2 B2 information exchange

```text
                         GitHub Actions
                              │
               ┌──────────────┴──────────────┐
               │                             │
      Global Stable / Best          China assets / pair knowledge
               │                             │
               └──────────────┬──────────────┘
                              │
                              ↓
                         Backblaze B2
                    nodeprobe-state/china/
                              │
             ┌────────────────┴────────────────┐
             │                                 │
       candidates.json                  pair-candidates.json
             │                                 │
             ↓                                 ↓
                         China machine
             │                                 │
        china-probe                    china-relay-probe
             │                                 │
             ↓                                 ↓
       observations/                    pair-observations/
             │                                 │
             └────────────────┬────────────────┘
                              ↓
                         B2 inbox
                              ↓
                       GitHub Actions
                              │
               ┌──────────────┴──────────────┐
               ↓                             ↓
      China asset evolution          Pair knowledge evolution
               │                             │
               └──────────────┬──────────────┘
                              ↓
                 direct.yaml + pairs.yaml
                              ↓
                         client.yaml
```

The four B2 transport objects are:

| Direction | Object | Producer | Consumer | Meaning |
|---|---|---|---|---|
| GitHub → China | `nodeprobe-state/china/candidates.json` | China workflow | `china-cycle.sh` / `china-probe.js` | bounded China node candidate feed |
| GitHub → China | `nodeprobe-state/china/pair-candidates.json` | China workflow | `china-cycle.sh` / `china-relay-probe.js` | bounded relay/landing experiment feed |
| China → GitHub | `nodeprobe-state/china/observations/*` | `china-probe.js` | China workflow | immutable China node observations |
| China → GitHub | `nodeprobe-state/china/pair-observations/*` | `china-relay-probe.js` | China workflow | immutable pair-path observations |

B2 is transport, not authoritative trust state. The authoritative persistent state is rebuilt on the GitHub side in:
- `data/china-node-assets.json`
- `data/china-pair-knowledge.json`

### 24.3 China machine cycle

`scripts/china-cycle.sh` is the local entry point:

```text
pull-stable
    ↓
pull-candidates
    ↓
china-probe
    ↓
push-observations
    ↓
try pull-pair-candidates
    │
    ├── feed exists
    │      ↓
    │  china-relay-probe
    │      ↓
    │  push-pair-observations
    │
    └── feed absent
           ↓
       skip Pair only
```

The systemd timer runs this cycle approximately every 30 minutes. The China machine requires no inbound service from GitHub; it only needs outbound access to B2 and the tested endpoints. The B2 credentials are supplied through the machine environment and are not stored in the repository.

### 24.4 GitHub China workflow cycle

The GitHub-side order is:

```text
restore China state/inboxes
    ↓
apply China observations
    ↓
apply Pair observations
    ↓
select next China candidates
    ↓
build relay-pair candidates
    ↓
build validated Pair pool
    ↓
build production Direct pool
    ↓
generate client.yaml
    ↓
save persistent state to B2
    ↓
publish next candidate feeds to B2
    ↓
commit generated subscriptions/config
```

This means the China machine normally probes using the latest candidate feed produced by a previous GitHub cycle. GitHub consumes the resulting evidence in a later cycle. The system is intentionally asynchronous; one GitHub cycle does not correspond one-to-one with one China probe cycle.

### 24.5 Data ownership

The information crossing the China boundary is deliberately asymmetric:

**GitHub → China**
- `candidates.json`: bounded selection containing both maintenance assets and newly discovered endpoint definitions;
- Pair experiment definitions.

**China → GitHub**
- endpoint identity;
- observation timestamp;
- probe environment;
- China-side reachability;
- direct proxy results;
- stability/attempt evidence;
- Pair baseline, screen and confirmation evidence.

The China machine does **not** send a trust decision. GitHub applies observations to the independent China asset.

Likewise, GitHub does not send Global reputation to the China machine.

### 24.6 Pair feedback loop

```text
Global Stable + China evidence + Global Best
                 ↓
     build-china-relay-candidates
                 ↓
       pair-candidates.json
                 ↓
           China machine
                 ↓
       pair-observations/*
                 ↓
     apply-china-pair-observations
                 ↓
      china-pair-knowledge.json
                 ↓
        build-china-pairs
                 ↓
          subscriptions/pairs.yaml
                 ↓
        next pair-candidates.json
```

Pair evidence never directly changes China node trust. A successful pair does not promote either endpoint, and a failed pair does not kill either endpoint.

### 24.7 Deployment invariants

1. Global Stable is the China exploration/discovery feed; the persistent China asset pool is the production maintenance boundary.
2. Global Best is used only for experimental landing selection.
3. `direct.yaml` is the production direct pool.
4. `pairs.yaml` is the validated experimental-path pool exposed to the client.
5. `relay.yaml` and `landing.yaml` are not production outputs.
6. B2 is asynchronous transport, not the source of truth for China trust.
7. China observation batches are immutable and replay-safe.
8. Pair observation batches are immutable and replay-safe.
9. China node trust and Pair knowledge are independent state machines.
10. Pair testing may be absent without blocking normal China probing.
11. The China machine never writes the Git repository.
12. GitHub never requires an inbound connection to the China machine.
13. Multiple China probe runs may accumulate between GitHub workflow runs and be consumed together.
14. Generated subscription/config files are outputs; persistent state remains in the corresponding state files.

### 24.8 Current local deployment command

After the repository is updated, the normal manual verification remains:

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

Pair testing is optional and can be checked separately once `pair-candidates.json` exists:

```bash
npm run china-sync -- pull-pair-candidates
npm run china-relay-probe
npm run china-sync -- push-pair-observations
```

The production systemd timer invokes `scripts/china-cycle.sh`, so these individual commands are primarily for first deployment and troubleshooting.

### China cold-start candidate bootstrap

A China probe machine may start before the Global/China candidate feed exists in B2. The cycle therefore treats the candidate feed as a scheduling artifact rather than a hard prerequisite:

- If `nodeprobe-state/china/candidates.json` is available, the machine pulls and uses it normally.
- If the candidate feed cannot be pulled, `china-cycle.sh` can use the pulled Stable feed only as a cold-start discovery source; normal maintenance remains based on the persistent China asset state.
- On a truly cold machine with no `data/china-node-assets.json`, this creates at most `CHINA_MAX_NODES` initial candidates from Stable and does not create China trust or observations by itself.
- The subsequent `china-probe` run creates the actual China observations; those are pushed to B2 and applied by the China workflow, which then publishes the next candidate feed.

Thus a missing candidate feed is a normal bootstrap condition, not a probe failure, while the probe remains bounded and never falls back to probing the entire Stable pool.


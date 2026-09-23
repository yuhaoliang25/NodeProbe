# NodeProbe Architecture

> Internal architecture document for maintainers and AI agents.
>
> This document explains **why** NodeProbe is designed this way. Code, generated YAML, and individual workflow runs are implementation details and must not be used alone to redefine the architecture.

## 1. Project Goal

NodeProbe is building and maintaining its **own persistent proxy-node pool**.

Sources are inputs to the system, not the final product.

The intended system is:

```
Source
  ↓
Discovery
  ↓
Validation
  ↓
Tracking
  ↓
Selection
  ↓
NodeProbe-owned Node Pool
  ↓
Subscriptions
```

The project should gradually become an inventory-maintenance system with incremental discovery, rather than a one-shot source-ranking system.

## 2. Discovery Memory

NodeProbe's internet discovery is stateful. Discovery is not just a repeated search for the same top-ranked repositories.

The persistent file `data/discovery-state.json` records three kinds of exploration memory:

- **channels**: per GitHub query/sort channel, including a rotating page cursor and recent run information;
- **repos**: repositories seen by discovery, including when they were last expanded;
- **sources**: sources used as crawler parents, including expansion history.

Current GitHub discovery uses multiple channels:

- `updated` — recently active repositories;
- `created` — newly created repositories;
- `stars` — mature/high-attention repositories.

Each channel advances through bounded search pages instead of repeatedly reading only page 1. Repositories are also given a revisit interval so a repository that has recently been expanded does not consume discovery capacity again immediately.

This creates a distinction between:

> **Search result freshness** — what GitHub currently ranks highly.
>
> **Discovery progress** — what NodeProbe has already explored.

The system should preserve this distinction. Search ranking alone is not a sufficient exploration strategy.

`data/discovery-state.json` is exploration memory, not source reputation. It must not be used to directly judge whether a proxy source or node is good.

## 2. Core Concepts

There are three distinct objects that must not be conflated:

### Source

A Source is an external information channel that can provide proxy-node candidates.

A source can:
- discover new nodes;
- remove old nodes;
- rotate its node list;
- continuously provide new information;
- become stale or stop updating.

A Source is **not** the owner of the nodes in NodeProbe's final pool.

### Node

A Node is an individual proxy endpoint discovered by NodeProbe.

A node has its own history:
- firstSeen;
- lastSeen;
- observed runs;
- health results;
- success/failure history;
- lifetime;
- current and historical sources;
- lifecycle status;
- historical trust evidence.

A node's quality must primarily be determined by evidence about that node itself.

### Node Pool

The Node Pool is NodeProbe's persistent inventory of known nodes.

It must survive source rotation.

A node disappearing from a source does not automatically mean that the node has died.

## 3. Source Reputation vs Node Lifecycle

This separation is fundamental.

### Source Reputation

Source reputation answers:

> "Is this source still a useful long-term scouting channel for NodeProbe?"

It considers:
- freshness / update activity;
- quality of nodes historically supplied;
- survival of supplied nodes;
- fetch / parse reliability;
- long-term evolution;
- source history.

It is used mainly for:
- source lifecycle;
- probe scheduling;
- deciding how much attention a source deserves.

Source reputation should **not** directly punish an individual node merely because the node came from a disliked source.

### Node Lifecycle Evidence

Node lifecycle evidence answers:

> "What lifecycle state and maintenance treatment should NodeProbe assign to this specific node?"

It is based on NodeProbe's own evidence:
- current health;
- historical health;
- success rate;
- latency;
- persistence / lifetime;
- recent failures;
- prior lifecycle / trust state.

A good node from a weak source can still be a good node.

Node lifecycle is derived from the node's own observations. Source reputation does not directly add or subtract node trust or node score.

## 4. Source Evolution

Source evolution is an observational layer.

For each source, observe how its node set changes over time:
- node count;
- added nodes;
- removed nodes;
- retained nodes;
- replacement rate;
- quality of replacements;
- long-term quality trend.

### Important rule

**High source churn is not automatically bad.**

A source may deliberately rotate nodes and still be valuable if it continuously discovers useful nodes.

Therefore replacement rate / churn is currently **observed, not directly penalized**.

The system should distinguish:

- Node Stability: whether a specific node remains useful over time.
- Source Evolution: whether a source continuously produces useful information.

These are different dimensions.

## 5. Node Lifecycle

The lifecycle is evidence-based.

The broad lifecycle remains:

```
NEW
 ↓
PROBATION
 ↓
ACTIVE
 ↓
STABLE
 ↓
STALE
 ↓
DEAD
```

The lifecycle is the persistent interpretation of node-level evidence.

In particular:

- **STABLE** means the node has accumulated strong positive evidence over time.
- **DEAD** means the accumulated evidence currently gives NodeProbe insufficient reason to trust the node.
- A lifecycle state is not simply a permanent label attached to the node.
- A previously stable node can temporarily fail and enter revalidation through the lifecycle rules without inheriting source-level judgments.
- A dead node may be given a recovery opportunity, but a successful observation alone does not restore trust.

The exact lifecycle thresholds remain implementation parameters.

## 6. Node Retention, Recheck, and Forgetting

Node history must have both **entry and exit**. Persistent memory is useful only if it remains bounded and semantically meaningful.

The node lifecycle therefore extends beyond DEAD:

```
NEW
 ↓
PROBATION
 ↓
ACTIVE
 ↓
STABLE
 ↓
STALE
 ↓
DEAD
 ↓
periodic recheck
 ↓
FORGOTTEN
```

### Dead is not permanent

A DEAD node is a historical judgment, not a permanent blacklist.

A dead node should remain in a low-priority recheck set for a while so that NodeProbe can distinguish:

- temporary failure;
- prolonged failure;
- genuine long-term disappearance.

Recheck frequency may decrease as the dead period grows. The exact backoff is an implementation parameter.

Conceptually:

```
DEAD
 │
 ├── recheck succeeds
 │       ↓
 │   recovery / re-admission evidence
 │
 └── recheck keeps failing
         ↓
    long-term DEAD
         ↓
      FORGOTTEN
```

A forgotten node is removed from the persistent per-node inventory. This prevents the node pool from growing forever merely because NodeProbe once observed an endpoint.

### Forgetting is a lifecycle event, not a denial of history

FORGOTTEN means:

> NodeProbe no longer keeps detailed per-node history for this endpoint.

It does **not** mean:

> This node never existed.

Long-term aggregate source evidence may remain even after the detailed node record is forgotten.

This creates an intentional asymmetry:

```
Node-level memory
    bounded / expiring

Source-level reputation
    longer-lived / aggregated
```

Source evaluation must therefore not depend on retaining every historical node identity forever.

### Forgetting criterion

Forgetting should require sustained evidence, not merely age.

A node should normally reach FORGOTTEN only after:

1. it has been classified DEAD;
2. it has remained unhealthy or otherwise unproductive for a sufficiently long period;
3. scheduled low-frequency rechecks have failed or produced no meaningful recovery evidence;
4. the retention policy says that further detailed per-node memory is no longer worth its storage and complexity cost.

The exact retention period and recheck schedule are implementation parameters.

### Initial retention policy for the 4-hour workflow

The current GitHub Actions workflow runs approximately every four hours. The first implementation should therefore use a simple time-based backoff rather than introducing a separate scheduler.

The initial policy is:

| Dead age | Action |
|---|---|
| ~4h | recheck |
| ~12h | recheck |
| ~1d | recheck |
| ~3d | recheck |
| ~7d | recheck |
| ~14d | recheck |
| ~30d | forget if no meaningful recovery evidence |

These are workflow-level eligibility points, not promises of exact wall-clock execution. A run checks which DEAD nodes have reached their next due point.

The policy should be implemented with a small amount of persistent scheduling state, for example:

- `deadSince` — when the node entered DEAD;
- `lastRecheckAt` — when the most recent scheduled recheck occurred;
- `recheckLevel` — which backoff point has been reached.

Do not create a large independent scheduler state machine. The node pool remains responsible for lifecycle interpretation; candidate construction is responsible for selecting due DEAD nodes for the next health-test run.

### Recheck scheduling boundary

A critical ordering rule is:

```
restore state
    ↓
discover / fetch sources
    ↓
build current candidates
    ↓
add due DEAD-node rechecks
    ↓
health validation
    ↓
update node pool
```

Therefore `update-node-pool.js` must **not** be responsible for initiating the recheck that it is about to record. It runs after health validation and is too late to put a node into the current test set.

The implementation should keep these responsibilities separate:

- **candidate/recheck selection** decides which historical DEAD nodes are due for observation;
- **health validation** produces the new evidence;
- **node-pool update** changes lifecycle state and advances the recheck schedule;
- **retention logic** removes a node when the forgetting criterion is satisfied.

### Recheck after DEAD

A DEAD node is intentionally retained for low-priority observation, but it must not consume the same testing budget as newly discovered or trusted nodes. Scheduled DEAD rechecks are therefore supplemental candidates and should be bounded so that a large graveyard cannot crowd out current discovery.

If a DEAD node produces a successful current observation, that observation is recovery evidence. One successful observation does not immediately restore the node; the recovery rule requires repeated healthy observations.

If the node fails its scheduled recheck, it remains DEAD and its next recheck moves farther into the future.

### Forgetting and source rediscovery

After the final retention point, the detailed node record should be removed from the persistent node inventory. A later source observation of the same fingerprint then naturally has no historical node record and can enter normal admission as a new node.

However, a source repeatedly rediscovering a forgotten endpoint that immediately fails should not recreate an indefinitely retained DEAD record on every run. Such observations should primarily contribute negative evidence to the supplying source and remain outside long-term node memory unless the endpoint demonstrates successful current validation.

This gives the system the desired direction of memory flow:

```
node history:     finite → expires
source reputation: long-lived → aggregates
```

The system therefore has both **entry and exit** for node memory without losing the longer-term ability to judge source quality.

### Rediscovery after forgetting

If a forgotten node later appears in a source again, NodeProbe must **not silently restore its old trust state**.

Instead, the observation starts a new admission epoch:

```
FORGOTTEN
   +
new source observation
   ↓
NEW / re-admission
   ↓
normal validation
```

There are two important cases.

**The rediscovered node is still dead**

The failed observation is useful source evidence. The source that supplied the dead endpoint can receive negative evidence from this observation.

However, NodeProbe should not recreate an indefinitely retained DEAD record merely because a source keeps rediscovering the same failed endpoint.

**The rediscovered node has actually recovered**

If the node passes current validation, it is treated as a **new admission**, not as an automatic restoration of its former trust.

This deliberately avoids carrying an obsolete negative trust debt forever while still preventing one stale source from turning a forgotten endpoint into a trusted historical node.

### Why this is desirable

The system should model the practical world rather than become an archive of every endpoint it has ever encountered.

A node that has been dead for a very long time is increasingly likely to be irrelevant to current source ecosystems. Retaining every such identity only to preserve source-evaluation evidence creates unbounded state.

Therefore:

> **Detailed node history is temporary memory; source reputation is the longer-lived statistical memory.**

The loss of some node-specific source evidence after forgetting is acceptable if the remaining source-level metrics still characterize source quality sufficiently well.

### Architectural invariant

Forgetting must never mean:

```
delete all evidence
```

It means:

```
expire detailed node identity/history
while retaining the source-level evidence that remains useful
```

The architecture should prefer bounded node memory over indefinite accumulation.

## 6. Source Absence Is Not Node Death

This is one of the most important rules.

If:

```
Source A
  run 1 → Node X
  run 2 → Node X
  run 3 → Node X disappears
```

Node X must not immediately be deleted.

Possible explanations include:
- Source A rotated its list;
- Source A temporarily failed to publish Node X;
- Node X moved to another source;
- Node X is temporarily unreachable;
- Node X actually died.

Only NodeProbe's own validation and accumulated history should determine the node lifecycle.

## 7. Persistent Node Pool

The persistent pool is the bridge between independent workflow runs.

Current data files include:

- `data/node-pool.json`
- `data/source-evolution.json`

The update process is conceptually:

```
Current Sources
      +
Historical Node Pool
      ↓
Candidate Set
      ↓
Health Validation
      ↓
Node Pool Update
      ↓
Current NodeProbe Inventory
```

This means NodeProbe is not rebuilt from zero every run.

Historical nodes can return to the candidate set and be tested again. Their accumulated observation history may affect **eligibility requirements**, but it is not converted into a separate trust or reputation score.

## 8. Health Validation

Health testing is NodeProbe's own evidence about nodes.

The general principle is:

```
Discovery says:
    "This node exists."

Health testing says:
    "What can NodeProbe observe about this node right now?"

Node history says:
    "What health evidence has NodeProbe accumulated for this node?"
```

External source metadata is therefore evidence for discovery and provenance, not unquestionable truth.

Repeated observations are important because Stable and Best are not intended to be admitted from an isolated observation when the node already has a relevant history.

### Current evidence and historical evidence

Historical health data is used directly as selection evidence where the current eligibility rules require it. For example, an existing node may need a minimum amount of recent historical evidence and a minimum historical success rate before it can enter Stable or Best.

This does **not** mean that the node has a hidden trust score.

The distinction is:

```
current health evidence
        +
historical health evidence
        +
stability confirmation
        ↓
Stable / Best eligibility
```

The persistent Node Pool separately records lifecycle state and maintenance scheduling. Lifecycle state determines when an asset is due for observation and how much current-run testing budget it receives; it is not a reputation score.

## 9. Node Lifecycle and Revalidation

NodeProbe no longer maintains a separate Node Reputation state layer.

Historical node evidence is represented directly by the persistent Node Pool and its lifecycle fields. The relevant distinction is between:

- current health evidence;
- accumulated historical observations;
- the node's current lifecycle state;
- scheduled maintenance/revalidation.

A current observation therefore changes the Node Pool lifecycle according to the existing state machine rather than updating an independent reputation score.

### 9.1 Existing healthy nodes

A node with established positive history can remain in active/stable lifecycle states while being periodically re-tested.

A single current failure does not erase its historical observations. Instead, the lifecycle records the failure and schedules the appropriate follow-up/revalidation according to the current maintenance policy.

Historical stability is therefore evidence for lifecycle interpretation, not a permanent exemption from testing.

### 9.2 DEAD nodes and recovery

A DEAD node is not necessarily forgotten immediately.

The Node Pool schedules bounded recovery rechecks. A successful recheck contributes recovery evidence; repeated successful observations can move the node back into an active/stable lifecycle state. A failed recheck keeps it DEAD and advances its recheck level. After the configured recovery sequence is exhausted, the persistent asset may be forgotten.

The current implementation represents this with lifecycle fields such as:

```
status
everStable
observedRuns
healthyRuns
failedRuns
recoveryRuns
deadSince
recheckLevel
nextProbeAt
```

These fields are lifecycle and observation state. They are not a separate Node Reputation model.

### 9.3 Testing budget is separate from lifecycle semantics

The number of rounds assigned by `test-google.js` is an evidence-collection budget.

It must not be confused with the Node Pool lifecycle itself:

```
build-subscriptions
    → decides which nodes need observation

test-google
    → decides how much current-run evidence to collect

update-node-pool
    → applies evidence to Node lifecycle and maintenance schedule

build-subscriptions / selection
    → derives Stable and Best from current evidence plus lifecycle history
```

The architecture should prefer these explicit lifecycle and observation fields over introducing another scalar Node Reputation score.

### 9.4 Separation from Source Reputation

Source Reputation remains a separate Source-level mechanism.

It may influence source scheduling and source lifecycle, but it must not directly add or subtract Node lifecycle state, node quality, or node health evidence.

A node's lifecycle is determined by evidence about that node.

## 10. Source Scheduling

Source reputation and registry state influence how frequently sources are probed.

Conceptually:

```
trusted   → frequent enough
normal    → regular
weak      → less frequent
degraded  → less frequent
stale     → infrequent
dead      → very infrequent
```

The exact intervals are implementation details and may change after observing real workflow data.

A source that becomes fetchable again may be given another opportunity; recovery should then be evaluated using actual source evidence.

## 11. Subscription Generation

The final YAML subscriptions are outputs of NodeProbe's own selection process.

They should not simply mirror a single external source.

Current/future pools may include concepts such as:

- best / general pool;
- country / region pool;
- stable pool;
- fast pool;
- adaptive pool.

The important invariant is:

> The subscription is a view of NodeProbe's own node inventory, not a copy of a source.

## 12. Geographic Detection

NodeProbe can detect the apparent geographic location of a node's server IP.

Current flow:

```
Node
 ↓
Server / hostname
 ↓
DNS / IP
 ↓
IP geolocation
 ↓
Detected country
 ↓
Country-aware selection
```

Declared source country and detected IP country are separate pieces of information.

Geographic detection is supporting metadata. It must not override direct health evidence about the node.

## 13. Data Model Responsibilities

Important persistent data:

| File | Responsibility |
|---|---|
| `data/candidates.json` | Current discovered candidate set |
| `data/history.json` | Multi-round health history |
| `data/node-pool.json` | Persistent NodeProbe-owned node inventory, lifecycle, and maintenance schedule |
| `data/node-pool.json` | Persistent NodeProbe-owned node inventory, lifecycle, and maintenance schedule |
| `data/source-history.json` | Historical source observations |
| `data/source-reputation.json` | Source-level reputation |
| `data/source-evolution.json` | Source node-set evolution |
| `data/discovery-state.json` | Persistent internet/discovery exploration memory |
| `data/ip-geolocation.json` | Cached node IP geolocation |
| `data/country-pool.json` | Country-pool selection information |

Do not casually merge these responsibilities. They exist at different abstraction levels.

## 14. Decision Boundaries

When changing the system, preserve these boundaries:

### Source-level decisions

Use:
- source freshness;
- source reliability;
- source quality;
- source evolution.

Do not use source churn alone as a negative signal.

### Node-level decisions

Use:
- current health;
- historical health;
- latency;
- persistence;
- failure history;
- lifecycle state and recovery history.

Do not automatically inherit a source's reputation.

### Pool-level decisions

Use:
- lifecycle;
- node quality;
- diversity;
- availability;
- historical assets.

The pool is the final product layer.

### Verification decisions

Separate:

1. **Scheduling** — which nodes receive test capacity;
2. **Testing budget** — how much probing capacity is spent;
3. **Evidence interpretation** — what a success/failure means given history;
4. **Acceptance** — whether the current evidence is sufficient for a node to enter a pool;
5. **Lifecycle** — what long-term state is stored.

A change to one layer must not silently redefine another.

## 15. What AI Maintainers Must Not Assume

An AI agent modifying NodeProbe must not assume:

1. The best source is the final objective.
2. A source with many rotating nodes is necessarily bad.
3. A node disappearing from a source means the node is dead.
4. A source's reputation should directly change an individual node's lifecycle or score.
5. A single workflow run is enough evidence to change an architectural threshold.
6. Historical node data is permanent. Node history has an explicit forgetting/retention lifecycle.
7. A node absent from the Node Pool after FORGOTTEN never existed.
8. A forgotten node rediscovered by a source should automatically inherit its old trust state.
9. Source reputation must retain every node identity forever in order to evaluate sources.
7. Generated YAML is the source of truth for the architecture.
8. Current implementation thresholds are permanent design decisions.
9. More scoring mechanisms automatically make the system better.
10. A mechanism should be added merely because it can be measured.
11. Equal test counts imply equal trust treatment.
12. A historical Best/Stable node should bypass health testing.
13. One successful test is enough to restore a DEAD node.
14. A single current failure is enough to erase strong positive historical evidence.

Before changing an architectural rule, inspect:
- `worklog/architecture.md`;
- the latest `worklog/checkpoint-*.md`;
- the relevant scripts;
- actual generated data from recent workflow runs.

## 16. Current Implementation Map

Major responsibilities currently include:

- `scripts/discover-sources.js`
  - stateful source discovery, GitHub exploration channels, source-link expansion and source probing schedule;
- `scripts/fetch-sources.js`
  - fetching source contents;
- `scripts/build-subscriptions.js`
  - candidate aggregation, source statistics, node scoring and subscription construction;
- `scripts/test-google.js`
  - multi-round health validation and health-history generation;
- `scripts/update-node-pool.js`
  - persistent node lifecycle and source evolution updates;
- `scripts/detect-ip-country.js`
  - node server IP geolocation;
- `scripts/convert-subscriptions.js`
  - conversion of generated node pools into Mihomo-compatible subscription/config outputs.

The GitHub Actions workflow orchestrates these stages.

## 17. Current Architecture in One Diagram

```
                    ┌──────────────────┐
                    │      Sources     │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │    Discovery     │
                    └────────┬─────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
     Source Evolution                Node Discovery
              │                             │
              ▼                             ▼
     Source Reputation                Health Testing
              │                             │
              │                             ▼
              │                     Historical Trust
              │                             │
              │                             ▼
              │                    Evidence Interpretation
              │                             │
              └──────────────┐              ▼
                             ▼       Persistent Node Pool
                       ┌────────────────────────┐
                       │ Persistent Node Pool   │
                       └────────────┬───────────┘
                                    │
                                    ▼
                               Selection
                                    │
                                    ▼
                         NodeProbe Subscriptions
```

## 18. Discovery Strategy

Discovery should evolve as an exploration problem rather than a static ranking query. The preferred order is:

```
GitHub / existing sources
        ↓
Discovery Memory
        ↓
New or insufficiently explored frontier
        ↓
Source candidates
        ↓
Source Registry
        ↓
Source Evolution / Reputation
```

Discovery memory answers **where NodeProbe has already looked**. Source reputation answers **whether a discovered source is useful**. Node lifecycle answers **what persistent state follows from an individual node's observations**. These questions must remain separate.

The current mechanism is intentionally conservative: bounded pages, bounded repository expansion, and bounded source-link expansion. The crawler should not become a general-purpose web spider.

## 19. Future Direction

The long-term direction is:

### Phase A — Memory

Make NodeProbe remember nodes and sources across runs.

### Phase B — Lifecycle

Make node retention/death decisions based on accumulated evidence rather than snapshots.

### Phase C — Source Evolution

Understand whether a source is:
- stale;
- consistently poor;
- useful but highly rotating;
- continuously discovering valuable nodes.

### Phase D — Better Selection

Build different views of the same NodeProbe-owned inventory:
- stable;
- fast;
- geographic;
- adaptive.

### Phase E — Adaptive System

Eventually allow source probing, node testing, and pool construction to adapt to observed system behavior.

The order is intentional: **memory first, then interpretation, then optimization**.

## 20. Engineering Philosophy

NodeProbe should favor:

- persistent evidence over snapshots;
- observation over assumptions;
- node-level evidence over source-level prejudice;
- incremental discovery over complete replacement;
- simple mechanisms over unnecessary complexity;
- reversible decisions over destructive deletion;
- real workflow data over premature threshold tuning.

When uncertain, preserve historical information and collect evidence before making an irreversible decision.

For historical trust specifically:

> **Trust should determine the burden of evidence, not eliminate the need for observation.**

A previously stable node is not permanently healthy. A DEAD node is not permanently unrecoverable.

## 21. AI Diagnostic Query Interface

> **AI MAINTAINER NOTICE — READ THIS BEFORE ANSWERING NODE-SPECIFIC QUESTIONS**
>
> Runtime state is intentionally stored outside Git. Do **not** assume that `data/*.json` exists in the repository or conclude that node history is unavailable merely because it is absent from the Git tree.
>
> When an AI agent is asked a question about a specific node, the intended path is:
>
>     User gives node name / identifying endpoint
>              ↓
>     Node diagnostic index (GitHub Actions artifact)
>              ↓
>     Locate node by fingerprint/shard
>              ↓
>     Read node-level observation/history summary
>              ↓
>     If needed, inspect the corresponding workflow run / artifact
>              ↓
>     Answer from observed evidence
>
> The diagnostic index is a **query interface for AI maintainers**, not a new source of truth. It is generated from the runtime state restored from B2 during the workflow and is published as a GitHub Actions artifact rather than committed to Git.
>
> ### What the diagnostic index is for
>
> It should make questions such as these directly answerable without asking the user to manually download B2 state:
>
> - What is this node's current status?
> - When did NodeProbe first observe it?
> - Which sources have observed it?
> - How many runs has it survived / passed?
> - What are its recent health results and latency?
> - What is the node's current lifecycle state and maintenance schedule?
> - Has it ever reached STABLE?
> - Is it currently active/stable, stale, DEAD, or in recovery?
>
> ### Query rules for AI agents
>
> 1. **Do not treat the current source list as the node's complete history.** Query the diagnostic index / persistent history first.
> 2. **Do not confuse `firstObservedAt` with publication time.** It is the first time NodeProbe observed the node.
> 3. **Do not infer node death from source disappearance.** Check node-pool status and health history.
> 4. **Do not expose or reproduce secret credential fields** when reporting node diagnostics. Use the safe identifying fields included by the diagnostic generator.
> 5. **Prefer recent workflow evidence for current health**, and node-pool and health-history evidence for persistence and lifecycle questions.
> 6. If the requested node cannot be found in the diagnostic artifact, say that the available diagnostic window does not contain it; do not invent historical data.
> 7. The artifact is diagnostic and temporary. Its retention period may limit how far back an AI agent can retrieve the detailed diagnostic index.
>
> ### Diagnostic index layout
>
> The index is sharded by the first two hexadecimal characters of the SHA-256 hash of the normalized node name. This avoids creating one excessively large diagnostic file while keeping lookup deterministic.
>
>     reports/node-index/
>       00.json ... ff.json
>
> The generated record combines the relevant node-pool and health-history fields into one node-centric view. It is deliberately smaller and safer than exposing the complete runtime state.
>
> ### Storage boundary
>
>     Git
>     ├── code / architecture / worklog
>     └── published subscriptions
>
>     B2
>     └── authoritative persistent runtime state
>
>     GitHub Actions Artifact
>     └── temporary AI diagnostic index
>
> **Important:** adding a diagnostic field or changing the query format must not cause `reports/` to be added to the normal Git commit. The diagnostic index exists specifically to preserve repository size while keeping runtime state queryable by AI maintainers.
>
> ---
>
> **Last architectural revision:** 2026-09-22
>
> Discovery memory revision: stateful multi-channel GitHub exploration added.
> Diagnostic query design revision: 2026-09-22
> Node lifecycle/recovery revision: 2026-09-22
>
> ## 22. Best Selection Audit Artifacts
>
> > **AI MAINTAINER NOTICE — USE THIS FOR INVESTIGATING WHETHER NODEPROBE'S FILTERING IS WRONG**
> >
> > The primary diagnostic question is not whether a node that is bad today can still connect. The important question is whether NodeProbe correctly evaluated the node **at the exact run in which it entered `best`**.
> >
> > Therefore the main workflow records detailed per-attempt health evidence during the normal selection run and publishes a temporary audit artifact for nodes that actually enter `best`.
>
> ### Design
>
> The normal health test remains the authoritative selection process.
>
> During `test-google.js`, every individual test attempt is recorded in an artifact-only trace:
>
> ```
> candidate
>   ↓
> stage1-fast
>   ↓
> stage1-retry (only if needed)
>   ↓
> stage2
>   ↓
> deep-round-3
>   ↓
> deep-round-4
>   ↓
> ...
> ```
>
> Each attempt records the stage, timestamp, timeout, delay, success/failure, and error when applicable.
>
> The detailed trace is written under `reports/health-test/` during the workflow only. It is **not written to B2**.
>
> The normal persistent `data/health.json` / `history.json` intentionally keep their existing compact runtime representation. They are still persisted to B2 as before.
>
> ### Best-only audit
>
> After `build-subscriptions.js` constructs `subscriptions/best.yaml`, `generate-best-audit.js` selects exactly those nodes that entered `best` and creates:
>
> ```
> reports/best-audit/
> ├── best-audit.json
> └── best-audit.md
> ```
>
> The report contains, for every selected node:
>
> - actual current-run health result;
> - complete individual test-attempt trace;
> - stage progression;
> - timeout and delay for every attempt;
> - current success rate / average latency / p95;
> - exact selection score;
> - every `bestEligible` condition;
> - historical health evidence used by the eligibility rule;
> - node-pool lifecycle and maintenance information;
> - node-pool persistence information.
>
> The artifact is retained by GitHub Actions for 30 days. It is not committed to Git and is not uploaded to B2.
>
> ### Why this is the preferred diagnostic path
>
> If a node later times out during actual use, the audit artifact lets an AI maintainer answer:
>
> 1. Did the node actually pass the normal health tests at selection time?
> 2. Which stages did it pass?
> 3. How many individual attempts passed?
> 4. What delays did NodeProbe observe?
> 5. Did the historical eligibility condition also pass?
> 6. What exact evidence produced its `best` inclusion?
>
> This separates:
>
> ```
> selection-time filtering error
>         vs.
> node degradation after selection
>         vs.
> intermittent behavior
>         vs.
> health-target mismatch
> ```
>
> A current manual retest of an already-selected node is therefore **not the primary debugging mechanism**. It may be useful for other investigations, but it cannot establish whether the original `best` decision was correct.
>
> ### Storage boundary
>
> ```
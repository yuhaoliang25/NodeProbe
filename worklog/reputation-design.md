# Reputation and Persistent Asset Design\n\n> Architectural notes recorded on 2026-09-22 for the reputation-system branch.\n\n## 1. Node Reputation and Source Reputation are Decoupled\n\nNode reputation and Source reputation are independent mechanisms. They may observe related raw evidence, but neither reputation is an input to the other.\n\nDo not implement:\n- Node reputation changing Source reputation;\n- Source reputation directly changing Node reputation;\n- recursive reputation propagation such as Source → Node → Source;\n- a global credit network between Sources and Nodes.\n\nThe reason is practical: NodeProbe already has better and more direct mechanisms for characterizing Nodes and Sources. Cross-propagation adds coupling and complexity for limited additional information.\n\nThe intended boundary is:\n\n```\nSource reputation → when should this Source be visited again?\nNode reputation   → how much testing effort should this Node receive?\n```\n\nA bad Source can contain a good Node. A good Source can contain a bad Node.\n\n> Source reputation judges the usefulness of the information channel; Node reputation judges the evidence accumulated about the individual endpoint.\n\n## 2. Source Reputation is Primarily a Scheduling Mechanism\n\nSource reputation is not a universal Source score. Its main operational purpose is to determine how often NodeProbe gives a Source another opportunity to produce new information.\n\n```\nSource history → Source reputation → next visit interval → new observation → update history\n```\n\nA particularly poor Source may therefore become effectively long-term blacklisted, but this normally means visit it extremely rarely rather than permanently prohibit it.\n\n## 3. Source History is Long-Lived, but Not Immortal\n\nSource history has greater temporal value than individual Node history because a Source can represent a long-running information channel, may reflect the behavior of a maintainer/operator, and generally survives longer than individual Nodes.\n\nHowever, historical information has finite predictive value.\n\nA Source that is both demonstrably poor and stale for a long time may be aggressively forgotten. Repeatedly crawling it would merely rediscover already-tested Nodes and produce little new information.\n\n```\nbad + long-term stale\n        ↓\ninformation value approaches zero\n        ↓\nforget Source\n```\n\nTherefore Source history should have a longer retention horizon than Node history, but it is still allowed to expire.\n\n## 4. Reappearance After Source Forgetting Starts From Zero\n\nIf a forgotten Source becomes active again, normal discovery can find it again. It then enters as a new observation subject and rebuilds reputation from current evidence.\n\n```\nforgotten Source → rediscovered → new admission → rebuild reputation\n```\n\nOld reputation should not automatically be restored. This follows a sliding-window interpretation: old behavior loses predictive value, while current behavior should establish current trust.\n\nThe cost of rebuilding reputation from zero is acceptable.\n\n## 5. Source Quality and Freshness are Different\n\nSource scheduling should distinguish at least:\n- quality: whether the Source produces useful Nodes;\n- freshness: whether the Source is still changing or producing new information.\n\nExamples:\n\n```\nhigh quality + stale → little new information\nlow quality  + active → information exists, but quality is poor\nlow quality  + stale → especially low information value\n```\n\nHigh churn alone is not automatically bad. A Source may intentionally rotate Nodes and still be valuable if it continuously supplies useful new information.\n\n## 6. Source is an Information Channel, Not Node Ownership\n\nA Source is not the owner of the Nodes it publishes.\n\nTherefore Source disappearance does not imply Node death.\n\nIf a Source stops publishing Node X, Node X remains in the NodeProbe-owned inventory until independent health and lifecycle logic determines otherwise.\n\nLikewise, forgetting a Source must not delete the Nodes previously discovered through it.\n\n## 7. NodeProbe Maintains Its Own Node Asset Pool\n\nThe testing model should not start from zero on every workflow run. NodeProbe maintains a persistent Node asset pool.\n\nSources are discovery channels that continuously inject new information into this pool.\n\n```\nSource A ─┐\nSource B ─┼→ Discovery → current candidates ─┐\nSource C ─┘                                  │\n                                             ├→ test selection → health\npersistent Node Pool ────────────────────────┘\n```\n\nThe Node Pool is NodeProbe own accumulated inventory. It survives Source rotation.\n\nSource is responsible for discovering; Node Pool is responsible for remembering.\n\n## 8. Sources are Still Re-crawled\n\nMaintaining a Node asset pool does not mean Sources are crawled only once.\n\nWhen a Source becomes eligible for another visit, NodeProbe crawls it again to:\n- discover new Nodes;\n- discover returning Nodes;\n- observe Source changes;\n- measure Source evolution;\n- obtain new information unavailable from the existing Node Pool.\n\nThe results are merged with the persistent Node inventory:\n\n```\nrevisit Source\n    ↓\ncrawl current contents\n    ↓\nmerge with Node Pool\n    ├─ new Node → admission candidate\n    ├─ known Node → refresh observation\n    └─ missing Node → no immediate Node death\n```\n\n## 9. Node Pool is a Core Long-Term Asset\n\nThe persistent Node Pool is not merely a cache of the latest Source results. It is one of NodeProbe core accumulated assets.\n\nConsequences:\n- Source rotation does not erase useful Nodes;\n- Node testing can use NodeProbe own history rather than Source publication alone;\n- previously known Nodes can continue to be tested after their original Source changes or disappears;\n- new Source information becomes incremental input;\n- subscriptions are views of NodeProbe inventory rather than copies of a Source.\n\n## 10. Node and Source Forgetting are Intentionally Different\n\nNode is a short-lived endpoint identity. Its detailed history should eventually be forgotten after prolonged failure and unsuccessful rechecks.\n\nSource is a longer-lived information channel. Its history survives much longer, but a Source that becomes poor and persistently stale can eventually be forgotten.\n\nAfter either object is forgotten, later rediscovery does not automatically restore obsolete trust. It starts a new admission/reputation process from current evidence.\n\n## 11. Final Responsibility Boundaries\n\n| Mechanism | Main question |\n|---|---|\n| Source discovery | Where can NodeProbe find information? |\n| Source reputation | When is this information channel worth visiting again? |\n| Node Pool | Which Nodes does NodeProbe currently know as assets? |\n| Node reputation | How much testing/evidential burden should this Node receive? |\n\nThe central invariant is:\n\n> Neither reputation system directly modifies the other.\n\nCross-source/node relationships may still be retained as observational data when useful, but they should not become another reputation propagation mechanism unless future evidence demonstrates a concrete need.\n\n## 12. Design Principle\n\n> Remember while history remains predictive; forget when old history no longer contributes useful information.\n\nFor Nodes the forgetting horizon is relatively short. For Sources it is longer because Sources are longer-lived and their historical behavior can be more informative. Neither should become an archive merely for completeness.\n\n**Status:** architectural discussion / design decision, before implementation.
## 13. Node Historical Trust Model

Node reputation is a historical trust prior, not merely a numeric score.

Initial states:

UNTRUSTED → NORMAL → TRUSTED

Initial transition rules:

- UNTRUSTED → NORMAL: cumulative tests >= 3 and cumulative success rate >= 2/3.
- NORMAL → TRUSTED: recent 6 observations have success rate >= 80% and everStable is true.
- TRUSTED → NORMAL: recent 6 observations have success rate < 50%.
- NORMAL → UNTRUSTED: recent 6 observations have success rate < 1/3.

These transitions intentionally contain hysteresis. One failure does not erase strong positive history, and one success does not erase strong negative history. TRUSTED does not jump directly to UNTRUSTED. Historical counters remain when trust falls.

The thresholds are initial implementation parameters, not immutable architectural constants.

## 14. Node Trust and Node Lifecycle Are Separate

Lifecycle and historical trust describe different dimensions. DEAD + TRUSTED is valid: the Node may currently be unusable while still having strong historical evidence. A newer Node may become STABLE before it has accumulated enough evidence to become TRUSTED.

Lifecycle reacts to current health and persistence. Reputation changes more slowly. Reputation must not prevent a Node from becoming DEAD. everStable is a historical fact, not a synonym for TRUSTED.

## 15. Node Reputation Controls Testing Burden, Not Hard Admission

Initial deep-test budget:

UNTRUSTED → 1
NORMAL → 2
TRUSTED → 3

This is resource allocation, not the trust definition itself. Reputation should not become a hard subscription gate. Current subscription eligibility should primarily use current health, history, stability and other direct selection evidence.

## 16. Observation Semantics

Every actual probe attempt is one reputation observation. A successful attempt contributes success evidence; a failed attempt contributes failure evidence.

Stage 1, Stage 2 and deep rounds have equal reputation weight in the initial implementation.

A Stage 1 retry is also a real observation. If Stage 1 fails and the retry succeeds, reputation records one failure and one success, even if the health layer considers the Node recovered for that run.

This keeps health semantics separate from reputation evidence.

## 17. No Same-Run Reputation Feedback

A workflow run must not use reputation generated by that same run to decide how much testing to perform in that run.

Previous reputation → testing budget → all current probing → current observations → update reputation.

Current observations become eligible to influence the next run.

## 18. Bounded Node Reputation Evidence

A persistent Node reputation record should retain durable aggregate evidence and enough recent evidence to evaluate trust transitions.

Conceptually it contains:

- successes;
- failures;
- recent successes/failures or equivalent bounded recent observations;
- lastTestAt;
- lastSuccessAt;
- lastFailureAt;
- everStable;
- trust.

The exact schema is an implementation detail. The important properties are durable cumulative evidence, bounded recent evidence, temporal timestamps, and an explicit trust state rather than an arbitrary scalar score.

When a Node is truly forgotten, its Node-specific reputation is forgotten with it.

## 19. Node Retention and Recheck

Node history must have both entry and exit.

For the approximately four-hour workflow, the initial retention policy is:

| Dead age | Action |
|---|---|
| ~4h | recheck |
| ~12h | recheck |
| ~1d | recheck |
| ~3d | recheck |
| ~7d | recheck |
| ~14d | recheck |
| ~30d | forget if no meaningful recovery evidence |

These are eligibility points rather than exact wall-clock guarantees.

DEAD Nodes receive low-priority recovery opportunities. The recheck schedule becomes increasingly sparse so a large graveyard cannot consume normal discovery/testing capacity.

Responsibilities remain separate: candidate selection chooses due DEAD Nodes; health testing produces evidence; node-pool update changes lifecycle and recheck state; retention logic forgets Nodes after the criterion is satisfied.

update-node-pool.js must not initiate the recheck it records because it runs after health testing.

## 20. Forgetting and Rediscovery

Forgetting removes detailed Node-specific memory; it does not mean the Node never existed.

After forgetting, a later source observation starts a new admission. Old trust is not silently restored.

If a rediscovered endpoint fails, repeated publication by a Source should not recreate an indefinitely retained DEAD record merely because the Source keeps publishing it. If it passes current validation, it can be admitted as a new Node epoch and rebuild trust from current evidence.

## 21. Source and Node Reputation Must Not Become a Mutual Scoring System

Source/Node relationships may be useful as observational data, but they should not become automatic reputation propagation.

Do not implement: Node bad → Source negative score, or Source good → Node positive score.

Such cross-credit creates recursive coupling and obscures the causal meaning of reputation.

The preferred architecture is:

Source reputation → Source visit scheduling
Node reputation → Node testing burden
Node Pool → persistent Node assets

Cross-analysis remains available for diagnostics and future research, but is deliberately excluded from core reputation calculation.

## 22. Current Unified Model

Source Discovery
    ↓
Source Reputation
    ↓
visit scheduling
    ↓
Crawl
    ↓
Node Asset Pool
    ↓
candidate selection
    ↓
Node Reputation
    ↓
testing burden
    ↓
Health
    ↓
Node Lifecycle
    ↓
retain or forget

The two reputation systems operate at different abstraction levels and time scales.

Source reputation asks: When is this information channel worth visiting again?
Node reputation asks: How much evidence should NodeProbe require before changing trust in this endpoint?
Node Pool asks: Which Nodes does NodeProbe currently own as persistent assets?

These questions should not be collapsed into one score.

## 23. Probe-Specific Trust, Cross-Probe Test-Fact Reuse

Google Probe and China Probe maintain independent Node asset pools and independent trust/reputation tables. Reputation is not a global property of an endpoint: the same endpoint may have different trust under different probing objectives.

A Probe may nevertheless reuse a concrete test fact produced by another Probe when that fact has a clear, narrower semantic meaning. In particular, China Probe may reuse the result that a Node has passed the Google Probe `stable` test to reduce redundant testing cost.

This is evidence reuse, not trust propagation:

```text
Google stable test result
        ↓
  reduce China test burden
        ↓
China-specific observations
        ↓
China reputation
```

Do not implement:

```text
Google trusted → China trusted
Google success rate → China trust
Google reputation → China reputation
```

The working assumption is that failure to satisfy the `stable` baseline means the endpoint is not useful as a relay candidate even if it happens to be reachable from China. Therefore re-testing that already-disqualified baseline property in China would usually add cost without useful information. China Probe still independently establishes China-specific reachability and stability.

This reuse is deliberately one-way and fact-specific. If the definition of `stable` changes, the reused result must be interpreted according to the corresponding test version/semantics rather than treated as permanent cross-Probe trust.

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
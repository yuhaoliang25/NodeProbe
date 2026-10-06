# Checkpoint 2026-10-06 — China Probe current architecture

## Purpose

This checkpoint records the current decisions after the China Probe, GEO routing and Sticky discussions. It is intended to prevent future maintenance from reverting to the older “test only new nodes / Global Best drives China” architecture.

## Current ownership

China is an independent trust domain.

- Global Stable: discovery/bootstrap input only.
- Global Best: not required for China production or pair generation.
- China machine: authoritative China state-transition engine.
- B2: asynchronous transport/storage boundary.
- GitHub China workflow: publication-oriented; it must not run a competing China state machine.

## Persistent maintenance

China candidate selection is not rebuilt from Stable each run.

Recognized China assets remain in the persistent asset pool when they disappear from Stable. Every run contains maintenance plus exploration. The default budget is 300 candidates, approximately 60% ordinary maintenance, 30% recovery and 10% new exploration after incumbent reservations.

A recent diagnostic run proved the invariant: 269 probation-recheck + 30 new + 1 ChatGPT incumbent were included in a 300-node run. Therefore maintenance assets really are entering the probe.

## Time-decayed evidence

China reliability now uses exponentially time-decayed observations with a default half-life of 72h. Old evidence ages rather than remaining permanently equivalent to recent evidence.

Lifecycle safeguards remain separate: minimum observations, failure streaks, recovery streaks and forgotten-node rechecks.

## Production selection

- Exit: all Trusted China assets with usable proxies.
- Elite: tiny production subset, normally <=3 paths.
- ChatGPT: independent capability pool, normally <=3, incumbent-first with exploration; it does not require Elite membership.
- Sticky: one persistent route for risk-sensitive services.
- Pairs: experimental fallback, secondary to ordinary exits.

Selection-layer membership does not mutate asset trust.

## Sticky policy

Sticky retains a healthy incumbent even when a newcomer scores higher. The incumbent is probed every cycle. Repeated failure or stale evidence releases it.

Replacement uses reliability as the primary criterion. A tiny continuity bonus prefers:

1. same IPv4 /24;
2. same IPv4 /16;
3. same IPv6 /48;
4. same IPv6 /64 region;
5. otherwise weak literal IP numeric proximity.

Default weight is 0.002. This is only a continuity heuristic and does not prove common ASN/ISP/ownership.

The previous incumbent is not permanently blacklisted and may recover into the normal eligible pool later.

## Client policy

Current intended routing:

    China/private -> Mihomo DIRECT
    ChatGPT -> CHATGPT
    X/Twitter/Threads -> STICKY
    other overseas -> PROXY
    fallback -> PROXY

Mihomo’s literal DIRECT strategy name remains unchanged. NodeProbe internal documentation should use Exit/China exit instead of ambiguous “direct” wording.

## Pair policy

Pair/relay work is experimental. Directly usable China exits remain primary. Pair evidence does not automatically change endpoint lifecycle. Missing pair candidates must not block ordinary China probing.

## Diagnostics and runtime data

Diagnostics must expose candidate categories/counts and probe outcomes so maintenance starvation is visible. Internal probe attempts are diagnostic evidence; one final observation per endpoint/run enters persistent lifecycle history.

Runtime state belongs in B2; temporary diagnostics belong in Actions artifacts; Git should not grow from raw runtime data.

## Time semantics

firstObservedAt is the first NodeProbe observation, not actual publication time. Source file modification time is not node publication time.

## Known failure patterns to preserve against

- testing only new Stable candidates;
- making ChatGPT a subset of Elite;
- depending on Global Best for China production;
- deleting China assets when Stable changes;
- allowing duplicate observation batches to inflate evidence;
- publishing malformed YAML/JSON without semantic validation;
- using “direct” internally where Mihomo DIRECT is meant;
- treating IP numerical proximity as proof of ASN/network continuity.

## Current local deployment

- repo: /home/lyh/NodeProbe
- cycle: scripts/china-cycle.sh
- service: nodeprobe-china.service
- Mihomo API: http://127.0.0.1:19090
- candidate budget: 300
- probe concurrency: 8

## Recent code checkpoints

- Sticky IP continuity implementation: commit 5dc513eb21a063079649329b8ed06520b5f33800
- Current architecture documentation: commits 26548c0e1f288bcda6aadde220901354ebf98a7a and af18455efe9cf1cbe3c5f95d8c853ac6c6ea3f91

## Next verification priority

Before further threshold tuning, run and inspect a complete China cycle. Verify maintenance candidates, Sticky/ChatGPT incumbent probing, generated subscriptions, client routing rules, B2 publication and release-marker ordering.

Date: 2026-10-06

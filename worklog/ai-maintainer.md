# AI maintainer log

## GitHub Actions run inspection

When diagnosing NodeProbe, the AI maintainer should inspect recent GitHub Actions runs before proposing a code change. The repository's workflow runs are public and recent runs can be queried directly from GitHub Actions.

Recommended diagnostic order:

1. Inspect the latest runs for `Update free nodes`.
2. Compare the latest failed run with the immediately preceding successful run.
3. Inspect the failed job's logs and identify the first concrete error, rather than inferring from the final workflow status.
4. If a failure occurs after a major processing stage has already succeeded, preserve those successful results and fix only the failing stage.
5. Record the run number, run ID, head SHA, failed step, and concrete error in this log before or together with the fix.

GitHub's workflow-run API supports listing recent runs and retrieving workflow/job logs; use those sources when available instead of relying only on the user's description.

## 2026-09-22 run #37

- Run ID: `35690958213`
- Head SHA: `2f717e109b1974d2c3c60ce3cedfe9274398c17c`
- Result: failure
- Earlier run #36: successful
- Run #36 ID: `35688545263`
- Run #37 reached the stability stage successfully:
  - provisional Best: 47
  - stability pass: 17
  - final Best: 17
- The actual failure happened later in `npm run best-audit`.
- Error: `ReferenceError: st is not defined`
- Cause: `generate-best-audit.js` referenced `st` in the audit result object without defining the stability record for the current node.
- Fix commit: `46120026810d19216b3a1fc6da645292a507d37d`
- Fix: resolve stability evidence with fingerprint first and node-name fallback, then expose it as `st` to the audit result.

Important: run #37 demonstrates that the previous stability-matching fix worked: the final Best set was 17 rather than being incorrectly reduced to zero. The remaining failure was diagnostic/audit-only and occurred after subscription generation.

## Fast preflight checks

Every workflow run now performs two lightweight JavaScript checks immediately after `npm install`:

- `npm run check`: Node's built-in parser check for every `scripts/*.js` file. This catches syntax/parse errors without executing the scripts.
- `npm run lint`: ESLint's `no-undef` rule. This catches basic undeclared-variable errors such as the `st is not defined` bug from run #37.

The distinction matters: `node --check` alone cannot catch `ReferenceError` cases caused by a syntactically valid but undeclared variable. The lint check is therefore included as the second layer. These checks run before discovery, network probing, Mihomo installation, and other expensive work.

## Operating principle

A recent workflow failure should be treated as runtime evidence. Do not diagnose from source code alone when a recent run is available. Always check the latest run logs, especially when the user reports simply that a run "failed".

## 2026-09-22 — Relay / Landing pool architecture

NodeProbe now has a planned second-stage view derived only from Best:

- Relay Pool = Best ∩ China-side reachable
- Landing Pool = the remaining Best nodes

The design intentionally reduces the problem dimension. Best already supplies the outbound/landing-quality assumption; the China-side probe adds only the missing user-network reachability dimension.

China-side reachability must have its own persistent history and evolution. A node that temporarily disappears from the current reachable set must not immediately lose its historical relay status.

Historical reliable relays are not permanently trusted. They must be deliberately sampled again because the China-side network path can change over time. Sampling should mix new/unknown Best nodes, current relays, historical stable relays, and recently failed relays.

The observation agent should run locally on the user's China machine, preferably as a systemd service/timer. The preferred control flow is pull Best → probe locally → persist/submit observations. GitHub should not depend on inbound remote triggering of the China machine.

The first probe should measure China → Node reachability rather than China → Node → Internet, so failures remain attributable to the new reachability dimension.
# API static-candidate dispositions

Whole-project follow-up to #3666, refreshed against `9e601f937683a7260a7f16d57aee050b0424b25b`. The source audit baseline remains in [scan-candidates.json](scan-candidates.json); the complete disposition ledger is [api-candidate-dispositions.json](api-candidate-dispositions.json).

This is a triage result. **254 records still require runtime or consumer-contract evidence before a code change is justified.** They are not confirmed defects, completed fixes or deletion instructions. Complexity scores are not observed latency. No production files, suppressions or dependencies changed.

## Refresh and coverage

- Installed API dependencies with `bun install --frozen-lockfile`; 273 packages installed and the committed lockfile stayed unchanged. The ledger records its SHA-256 and the full existing Fallow configuration.
- Ran locked Fallow **2.103.0**, whole project, with `fallow --format json` from `src/api`. Refreshed after the documentation merge; issue counts and clone fingerprints remained identical.
- Current result: **105** dead-code/dependency findings, **83** clone groups and the scanner's **100** reported complexity findings. The original snapshot had 113, 85 and 100 respectively. Clone fingerprint churn is recorded explicitly; disappearance is not automatically a fix.
- Retained dispositions for 13 original dead-code/clone records absent from the current result, producing **301 ledger records**. All original complexity path/function identities remain represented. This scope is the original candidate report and its corresponding refreshed categories, not every possible scanner metric (for example, all 617 `large_functions` informational entries).
- All health coverage fields remain labeled **estimated**, never measured execution coverage. Configured child-process, worker, harness and migration entry points remain visible in the ledger. Existing ignored dependencies and stale suppression are retained.

| Disposition                   | Records | Meaning                                                                                             |
| ----------------------------- | ------: | --------------------------------------------------------------------------------------------------- |
| Confirmed                     |       2 | Narrow cleanup with source evidence and a bounded issue                                             |
| False positive                |       5 | Existing interface dispatch or separate state invalidates the removal inference                     |
| Intentional checked duplicate |      30 | Inspected syntax shares a shape while the operation/lifecycle remains deliberately distinct         |
| Already tracked               |      10 | Linked landed or queued work covers the candidate                                                   |
| Requiring runtime evidence    |     254 | No sufficient basis to remove, unify or split; preserve code until the recorded contract is checked |

“Intentional checked duplicate” is the ledger's shared allowed label for deliberate repetition, including one lazily initialized import cycle; the per-record reason states the actual construct. It does not mean a new runtime test was executed.

## Confirmed, bounded follow-ups

1. [#3708 — unreachable burst-sibling module](https://github.com/zubair-io/Maple/issues/3708). `src/enrichment/burst-siblings.ts` has no repository import/caller. Exact `findBurstSiblings` tracing says the module is unreachable from configured entry points. It is neither generated nor a framework-discovered route. Recheck before removal; do not invent a new behavior to consume it.
2. [#3707 — identical upload-session reset mutation](https://github.com/zubair-io/Maple/issues/3707). The two reset branches in `src/backup/upload-session.ts` repeat the same unset/set/reload mutation. Keep their different triggers, BusyElsewhere behavior and chunk-file reset contract; share only the mutation after real regression tests exist.

The backup move clone is already removed by #3687/#3644. Location naming remains represented as tracked #3661/#3689 because it had not landed at this snapshot. The original DB bootstrap cycle disappeared after #3674. The orphan indexer-repository findings disappeared with the strict API cleanup; the original ID constants disappeared with the separately owned ID consolidation. These are historical comparisons, not additional fixes in this PR.

## Important non-removal decisions

- **Provider methods:** concrete `health`/`describe` warnings do not survive tracing through `DescribeProvider`, its factory and `describe-bootstrap`/`workers/stages/describe.ts`. Methods are reached through the interface. Provider `name` properties remain a consumer-contract question, not automatically dead.
- **Same exported name, different state:** the two `setMeilisearchClientForTests` functions replace different variables: the shared singleton and the stage-local override. Combining them would change test isolation.
- **Atomic sidecar I/O:** overwrite uses rename; create-if-absent uses link with EEXIST semantics. Shared temp-write text does not make these the same operation. Existing wrappers already share the lower-level sidecar writer.
- **Versioned migrations:** similar query/update loops can intentionally preserve the rule that applied at a particular migration version. Live-policy extraction could alter historical replay semantics. This is especially relevant to stage rearming and face-count aggregation.
- **Test imports and public exports:** `rename-reconcile.test.ts` imports the EXIF module namespace but only spies on `readExif`; this does not establish a caller of `normalizeExif`, which remains unresolved. Other word matches are often comments, local helpers with the same name or unused namespace members. The ledger retains exact import syntax and tool traces rather than declaring those matches callers. An unused export modifier is not proof its function body is unused internally.
- **Package alias:** source imports use `maple`; `@justmaple/maple` points to the same local package and has no traced source import. Docker/Bun/native package installation behavior still needs verification before deleting that declaration.
- **Lazy face-pool cycle:** `face-detector` uses a type-only top-level import and a documented lazy `require` inside the factory. This differs from the repaired DB bootstrap cycle. No initialization failure was demonstrated here.
- **Suppression:** the `duplicates` comment in search buckets is reported as an unknown/stale kind. Its rationale is retained and the current buckets/facets clone still exists; blindly removing or widening it would not establish the intended gate behavior.

## Where further evidence has the highest value

These are review priorities, not defect claims or new refactor tickets:

| Area                                    | Concrete repeated policy / risk                                        | Evidence needed before a change                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Backup raw/rendered ingestion           | Chunk reset, append offsets and completion have long repeated sections | Real temporary-file retry/offset/failure tests; distinguish originals from rendered companions |
| Browse and filesystem routes            | Absolute-path/realpath jail, child re-resolution, cursor/ETag behavior | Symlink-swap and containment tests plus full/fast listing response parity                      |
| Auth adapters                           | Challenge consumption, PKCE, access/refresh token shapes               | End-to-end replay, device-family and account-binding cases; retain guard ordering              |
| Search query builder and route handlers | Large branch tables and Mongo pipelines                                | Representative query correctness and DB plans/latency; estimated coverage is insufficient      |
| Describe providers and worker pools     | Similar response extraction and crash cleanup                          | Per-provider payload fixtures and child crash/stop/retry behavior                              |

The ledger carries a decision and boundary reason for every refreshed clone. Every complexity record retains its path, function, line, metrics and estimated coverage; no function receives a rewrite ticket solely because it ranks highly.

## Reproduce or extend

From a clean current-main worktree:

```sh
cd src/api
bun install --frozen-lockfile
./node_modules/.bin/fallow --format json > /tmp/maple-api-candidates.json
./node_modules/.bin/fallow dead-code --trace src/enrichment/burst-siblings.ts:findBurstSiblings --format json
./node_modules/.bin/fallow dead-code --trace-dependency @justmaple/maple --format json
```

Exact symbol traces for the flagged exports/types are retained in the ledger. Direct import evidence was checked with TypeScript's parser and repository searches; namespace imports and same-name text are not treated as proven uses. Compare current candidate identities, preserve disappeared baseline evidence and update individual dispositions only when new evidence supports it. No `fallow fix` command was run.

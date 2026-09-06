# Non-Apple batch synchronization slice of #3311

This slice implements the transfer framework, the Web value preview, and a persisted Self Hosted runner. It does not complete the parent issue's Relative white-balance case, Apple UI/actor queue, or paired RAW rendered acceptance.

## Delivered behavior

- Every grouped field has a reviewed transfer mode in raw-core. Codegen emits matching TypeScript and Swift tables. Copy exclusions and parser-only `temperature_seen`/`tint_seen` are Unsupported; crop uses normalized AssetRelative coordinates; supported authored fields use Absolute. Relative is an explicit, currently unassigned mode.
- The Web clipboard deep-copies curves. Selected point curves now survive paste and XMP serialization. White-balance paste preserves As Shot and scale semantics and clears destination-only sample coordinates/version.
- The selective-paste dialog snapshots source and target selection, reads cold Self Hosted sidecars with at most eight requests in flight, and shows each group's actual before/after values and changed-photo count. Failed reads disable confirmation.
- Self Hosted uses `batch_adjustment_sync` jobs. Mongo stores the immutable target list/patch and per-target prepared/applied/failed ledger. Progress, cancellation, resume, retry-only-failed, and per-photo error summaries survive restart. Browser storage keeps a job identity before submission, allowing recovery after a lost creation response. Repeated creation with that identity returns the same job.
- The server reads and atomically updates only sidecars. A namespace-aware patcher changes selected attributes/curve elements while preserving unrelated attributes, nested masks, comments, and foreign RDF subjects. Interrupted prepared writes reconcile SHA-256 before/after hashes; changed sidecars become per-photo conflicts. Completed targets are never replayed. Checkpoint and runner terminal writes are fenced to the current lease owner.
- Hosted continues to use its existing in-memory runner. Server transport is supplied only by the Self Hosted composition root through an optional injection token.

## Verification on Windows, 2026-09-06

The private MongoDB 8.2.6 test instance and all originals/sidecars lived in disposable test locations. No user's photos were used or modified.

- `cargo test -p codegen`: 48 tests passed.
- `cargo test -p raw-core --lib types::adjustment::schema::groups`: 7 tests passed.
- API transfer, job repository, runner, and route tests: 29 passed against real Mongo and real temporary sidecars, including an enabled 2,000-target measurement.
- The 2,000-sidecar run took **96,638 ms** (about 21 sidecars/s). API-process RSS was **112 MiB** before the run and peaked at **213 MiB**. This includes full checkpoint persistence and atomic filesystem writes; fixture creation was outside the timed region. Mongo's process memory is not included. Originals contained sentinel bytes because this path never decodes an image.
- Web: **69 tests passed** across 11 files, covering the group/clipboard/XMP contract, bounded preview reads, persisted runner recovery, and dialog behavior.
- Both `maple-syrup` and `maple` production builds passed. The Hosted capability boundary passed at **1,161,070 eager bytes**, below its 1,163,000-byte limit and the clean base's 1,162,238 bytes. The paste dialog, preview reader, and group-patch builder load on demand.
- Changed API files passed oxlint; generated Web/API/Swift transfer outputs match fresh codegen byte-for-byte. Formatting, file-budget, and budget-headroom checks passed.

The repository-wide API `tsc --noEmit` check still reports unrelated diagnostics, including the missing `src/indexer/channel.ts` import and existing Mongo/token test type mismatches. It reports no diagnostics in the files changed by this slice.

The measured workload is synthetic sidecar I/O on a local disk, not a real RAW library, rendered pixel parity, or a declared cross-machine throughput budget. Job recovery checks do not create a distributed filesystem transaction with other applications editing the same sidecar concurrently.

## Remaining acceptance inputs

Relative WB needs a shared per-asset as-shot temperature/tint baseline exposed to the transfer layer and a versioned correction/persistence contract. Current `AdjustmentModel` holds edited/display temperature/tint, source, sample coordinates, and algorithm/scale versions, but no durable source/target as-shot baseline pair. Inferring that baseline from the current display values would turn authored WB into a guessed correction. #2434 owns that reference implementation; this slice exposes no nonfunctional Relative UI.

Paired-fixture acceptance still needs different camera white points and dimensions, the agreed relative correction cases, and rendered reference results with acceptance budgets. The reported synthetic I/O measurement supplies none of those pixel assertions. Apple actor persistence and Apple value-preview UI are explicitly outside this non-Apple slice.

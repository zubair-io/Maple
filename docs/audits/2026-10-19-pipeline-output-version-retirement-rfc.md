# RFC: Retire `PIPELINE_OUTPUT_VERSION` — delete the counter, its evidence cascade, and its PR serialisation, keep cross-language codegen

**Status**: Proposed
**Authors**: Maple maintainers
**Date**: October 19, 2026
**Issue**: [#5007](https://github.com/zubair-io/Maple/issues/5007) (`ktlo`, `priority:medium`, `effort:L`)
**Baseline audited**: `origin/main` (`b9b5f75519`)
**Related**: #1926 (counter introduced), #4793 (shared derivatives decoupled — merged), #2430 (capability registry / evidence records), #1780 (the `WbScaleVersion` converter pattern), `docs/pipeline.md`, `docs/caching.md`, `docs/testing.md`, `docs/xmp-canonical-format.md`, `CLAUDE.md`

> [!NOTE]
> This document is both the RFC (the decision record) and the implementation plan (Section 10). Section 10 is the executable plan; everything before it is the justification a reviewer needs to approve it without re-deriving it.

---

## 1. Executive summary

`PIPELINE_OUTPUT_VERSION` is a monotonic `u32` in `src/raw-pipeline/raw-core/src/version.rs` (currently **29**) that was introduced by #1926 to answer one question: _when the develop pipeline produces different pixels for the same `(RAW, XMP sidecar)` input, how does every derived artifact know it is stale?_

That question has since been answered differently, and better, for every surface the counter used to drive:

- **Shared thumbnails and previews** no longer carry the counter at all (#4793, merged): filenames, HTTP identities, server stage targets, and Cloudflare R2 keys are all version-free or frozen literals.
- **Apple's rendered-preview cache** keys only on the asset's own state (original and sidecar mtimes).
- **Stored sidecar values** that change meaning are protected by per-field load-time converters, whose working exemplar is `papp:WbScaleVersion`.

What remains coupled to the counter in current `origin/main` is only its cost:

1. The **capability-registry evidence rule**, which demotes capabilities whenever the counter moves, forcing five CI-gated evidence records to be re-recorded for every colour tweak.
2. A **`CLAUDE.md` PR-serialisation rule** — only one open PR may own a bump — which collided four times on #4900.
3. A set of **generated mirrors** (Swift, TypeScript, Kotlin, C#) that no production code reads for any decision; two test specs assert only that the mirrors agree with each other.

**Proposal.** Delete the counter and everything that gates on it. Keep the cross-language codegen that keeps every other constant and schema identical — that machinery is the only part worth its cost. Make evidence records go stale only on what they actually measure (their corpus). Document, as a merge rule, that a silent reinterpretation of a stored sidecar value must ship a per-field load-time converter — no converter, no merge.

No pixel output changes. No cache behaviour changes. #4793 already absorbed every cache consequence of this decision.

---

## 2. Background

### 2.1 What the counter is

`raw_core::PIPELINE_OUTPUT_VERSION: u32 = 29` is single-sourced in `src/raw-pipeline/raw-core/src/version.rs` and emitted by the `codegen` crate (`tools/codegen.sh`) into per-language mirrors, guarded by the `codegen-drift` CI job.

The #1926 bump policy, still documented in that module:

> A raw-core change increments `PIPELINE_OUTPUT_VERSION` by one whenever it alters the pixel output of the develop pipeline for any input, or silently reinterprets an already-stored `AdjustmentModel` value without a load-time converter. A change that adds a new slider left at its identity default, fixes a non-output-visible bug, or only touches an estimator used when no value is authored does not bump it. When in doubt, bumping is the safe direction.

The lineage runs v1 (initial epoch, #1926) through v29, recording demosaic retunes, AgX white-point remaps (#3601), highlight-recovery changes (#3267, #3633), slider-direction flips (#3592), and similar output changes. The motivating failures it was built to prevent were real: #1733 (HSL saturation moved from hard clip to soft-compress) and #1083 (capture-sharpening radius reinterpretation) both changed what a stored number meant with nothing recording the boundary.

### 2.2 The two tools, and why only one survives

`version.rs` itself documents the counter as the _cheaper, weaker_ of two tools for the same problem class:

| Tool                                    | Mechanism                                                                                                                              | Preserves authored look?                                                                                                                                          | Cost                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `PIPELINE_OUTPUT_VERSION`               | One global counter folded into derived-artifact keys; a bump invalidates everything                                                    | No — it only invalidates; the pre-change look is gone                                                                                                             | One bump per colour change, plus every coupled re-record and invalidation (Sections 3, 4) |
| Per-field stamp (e.g. `WbScaleVersion`) | A version stamp written into each sidecar (`papp:WbScaleVersion="1"`–`"5"`); on load, an old value is converted into the current frame | Yes — exactly (`authored_pair_to_v5` in raw-core, `xmp-wb-scale.ts` on Web, `WbDngTemperature.authoredPairToV5` on Apple, `XmpWbScaleVersionTests.cs` on Windows) | One converter per affected field, only when that field's meaning actually changes         |

For white balance, the stamp won: five successive scale changes (documented in `docs/xmp-canonical-format.md`) were each absorbed by a converter, and old sidecars still render as authored. The counter's remaining job — "invalidate derived pixels" — is now done by #4793's design without it (Section 4.1).

### 2.3 History relevant to this retirement

- **#1926** introduced the counter, initially because no cache consumed a canonical version at all.
- **#1927 / #1928** wired it into the Web thumbnail cache and Apple's `RenderedPreviewCache`.
- **#4793** (closed) reversed that wiring for every shared derivative — see Section 4.1 — after it became clear that a colour PR should not regenerate, re-sync, or reject every thumbnail and preview in every library.
- **#4900** collided four times on the one-bump-at-a-time serialisation rule. This is the proximate cause of #5007.

---

## 3. Problem statement

### 3.1 The evidence cascade

The release-state rule in `src/raw-pipeline/raw-core/src/capability_registry/evidence.rs` (`judge()`, #2430) judges a committed evidence record **first** on `record.pipeline_version != build.pipeline_version` (`StalePipeline`), then on schema version, and only then on the things the record actually measures: corpus hash, accepted backend, expected/executed/failed/skipped counts.

Consequence, documented at `docs/testing.md:552–556`: bumping the counter turns every affected source unsatisfied on the next `tools/codegen.sh` run, `codegen-drift` refuses to merge until the demoted registry outputs are committed, and the five CI-gated records — `synthetic_grey`, `color_chart`, `grey_adjustments`, `grey_dcp`, `sidecar_contract_api` — must be re-recorded. The records assert "this corpus, run on this backend, passed". A colour tweak changes none of those statements unless the corpus itself changed — yet the records are invalidated as if it did. The coupling confuses _the pipeline produced different pixels_ (already gated directly by `src/scripts/test_color_pipeline.sh`, the budgets ratchet, and `budgets.json`) with _the evidence about this corpus is stale_.

### 3.2 PR serialisation

`CLAUDE.md:291` (current `origin/main`):

> **One pipeline-version bump at a time.** A change to `PIPELINE_OUTPUT_VERSION` forces re-recording the five CI-gated evidence records … Before bumping, run `gh pr list …` and look for any other PR touching `raw-core/src/lib.rs` or the qualification records; if one exists, wait for it to merge and take the next free version.

Two unrelated colour PRs therefore cannot be open at once without a human-mediated queue. #4900 hit this four times. This is pure process tax: it exists only because the counter is a single shared integer that the evidence rule consumes.

### 3.3 Dead mirrors

On current `origin/main`, outside code generators and generated files, **no production code reads any mirror of the counter to make a decision**. The complete reader list is:

- `src/web/projects/maple-common/src/lib/editor/capability-registry.spec.ts` and `camera-support.spec.ts` — assert the registry build stamp equals the adjustment-model mirror. They test that codegen copied a number correctly, nothing else.
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CapabilityRegistryTests.swift` — asserts the stamp is `> 0`.
- `src/windows/Maple.WinUI.Tests/CapabilityRegistryTests.cs` (`BuildIdentityIsPositive`) — asserts `CapabilityRegistry.PipelineOutputVersion > 0`. (Its sibling schema assertion at line 58 is _not_ a counter reader and stays.)
- `src/raw-pipeline/raw-napi/src/lib.rs` — the `maple_napi_version()` smoke export reads the counter _deliberately_, "rather than returning a bare literal — that is what makes the heavy raw-core graph genuinely part of the addon's link". The value is load-bearing for link-forcing, not for its meaning.

A constant whose only readers are mirror-consistency assertions is not a safety mechanism; it is a maintenance surface.

### 3.4 What the counter no longer protects

After #4793 (Section 4.1), a missed bump no longer "serves stale pixels indefinitely", which was the #1926 argument for bumping when in doubt. Shared derivatives are refreshed only when the original or its sidecar changes — by design, and independent of the counter. The counter's invalidation function is gone; only its demotion and serialisation functions remain.

---

## 4. Current-state audit (against `origin/main`, `b9b5f75519`)

> This audit was performed on `origin/main` directly (`git grep` / `git show`), not on a local checkout: the working branch used during early drafting of #5007 was 1,429 commits behind and materially overstated the remaining scope (it still showed `.v<N>` derivative filenames, `?pv=`, and an R2 key derived from the counter — all already removed upstream). Every claim below is from `origin/main`.

### 4.1 Already decoupled by #4793 — out of scope, must not be touched

| Surface                 | State on `origin/main`                                                                                                                                                      | Evidence                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared thumb filename   | `.maple/thumbs/<filename.ext>.avif` — no hash, no version                                                                                                                   | `docs/caching.md` § "The shared `.maple/` folder"                                                                                                               |
| Shared preview filename | `.maple/previews/<filename.ext>.avif`; Web fallback artifacts, descriptors and source identities likewise unversioned                                                       | `docs/caching.md` § "Pipeline output version"; `preview-cache-protocol.ts` (`LEGACY_DERIVATIVE_SEGMENT = '.v25'`, "must never track `PIPELINE_OUTPUT_VERSION`") |
| HTTP                    | No `?pv=`, no `X-Maple-Pipeline-Version`; server ignores a legacy `pv`, never `409`s on version, accepts preview `PUT` with or without the header; content-based ETags only | `docs/caching.md` § "Pipeline output version"                                                                                                                   |
| Server stages           | `THUMB_TARGET_VERSION = PREVIEW_TARGET_VERSION = 29`, frozen literals, "a pipeline bump must never re-arm thumbnail or preview generation"                                  | `src/api/src/workers/derivative-versions.ts:1`                                                                                                                  |
| Cloudflare R2           | `thumbs/<slug>/<relDir>/<filename>/v25` — frozen literal (`FROZEN_R2_KEY_VERSION = 25`), "every object already in the bucket lives under /v25"                              | `src/cloudflare/src/r2.ts` (`thumbR2Key`); `src/api/src/cloudflare/thumb-key.ts:22`                                                                             |
| Apple rendered preview  | Key is the asset's own state only (original + sidecar mtimes); the former local `viewTransformVersion` "was a pipeline-version proxy and was removed with #4793"            | `docs/caching.md` § "Pipeline output version", § "Apple"                                                                                                        |
| Legacy on-disk names    | Readers rename exactly one frozen legacy name into place on a miss (`.v25`); `cache-gc` "no longer migrates anything (#4928)" and leaves retired names untouched            | `docs/caching.md` § "Legacy names and rename-on-miss"; `src/api/src/fs/legacy-derivative.ts`                                                                    |

**Implication.** The cache half of the original #5007 scope is already implemented and merged. This RFC must not re-open any of it: no filename change, no R2 re-key (a re-key would orphan every edge-cached object and force the mass re-upload #4793 explicitly avoided), no change to the legacy rename-on-miss readers.

### 4.2 Still coupled — the entire remaining scope

| #   | Coupling                      | Location(s) on `origin/main`                                                                                                                                                                                                                                                                                                                                                                                                                         | Nature                                                                |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | The counter itself            | `src/raw-pipeline/raw-core/src/version.rs` (`= 29`); `pub use` in `raw-core/src/lib.rs`                                                                                                                                                                                                                                                                                                                                                              | Source of truth; delete                                               |
| 2   | Evidence staleness rule       | `capability_registry/evidence.rs` — `BuildIdentity { pipeline_version, schema_version }`, `EvidenceRecord.pipeline_version` / `.schema_version`, `RecordStatus::StalePipeline` / `StaleSchema`, checked in `judge()` before corpus/backend/counts                                                                                                                                                                                                    | Behavioural; the cascade (Section 3.1)                                |
| 3   | Evidence record writer        | `codegen/src/qualification_record.rs:129` stamps `pipeline_version: PIPELINE_OUTPUT_VERSION`; records under `test-fixtures/qualification/` (incl. the five CI-gated: `synthetic_grey`, `color_chart`, `grey_adjustments`, `grey_dcp`, `sidecar_contract_api`)                                                                                                                                                                                        | Writer + committed data                                               |
| 4   | Registry/support build stamps | `codegen/src/capability_registry.rs`, `support_tiers.rs` (Swift/TS emitters), `support_tiers_cs.rs` (C# `PipelineOutputVersion` const → `CameraSupportRegistry.g.cs`), `capability_summary.rs`, `support_tiers_summary.rs` (JSON/MD `build.pipeline_output_version`); all nine `evidence.build.expect(...)` sites (Section 7.1.1)                                                                                                                    | Generated mirrors; delete field, re-source `schema_version`           |
| 5   | Adjustment-schema mirrors     | `codegen/src/adjustment.rs` (Swift `AdjustmentModel.pipelineOutputVersion`, TS `PIPELINE_OUTPUT_VERSION`), `adjustment_api.rs` (API TS), `android.rs` (Kotlin `AdjustmentFields.pipelineOutputVersion` → `src/android/.../generated/AdjustmentFields.kt`)                                                                                                                                                                                            | Generated mirrors; delete field                                       |
| 6   | Standalone version schema     | `codegen/src/main.rs` — `Schema::PipelineOutputVersion` → Swift `MaplePipelineVersion` (`MapleCloudKit/Generated/PipelineOutputVersion+Generated.swift` via `tools/codegen.sh:121`), TS for Cloudflare                                                                                                                                                                                                                                               | Whole schema; delete                                                  |
| 7   | `raw-napi` smoke export       | `raw-napi/src/lib.rs` — `maple_napi_version()` formats `"(raw-core pipeline output v{})"` from the counter to force the raw-core link                                                                                                                                                                                                                                                                                                                | Sole semantic reader; repoint (Section 7.4)                           |
| 8   | Mirror-consistency tests      | `capability-registry.spec.ts`, `camera-support.spec.ts`, `CapabilityRegistryTests.swift`, `CapabilityRegistryTests.cs` (`BuildIdentityIsPositive`), `capability_registry/tests.rs`, `support_tiers/tests.rs` and `capability_registry/color_corpus/tests.rs` (both construct `BuildIdentity` / `EvidenceRecord { pipeline_version, schema_version, .. }`), codegen emitter unit tests (`capability_registry.rs`, `support_evidence.rs` test modules) | Update or delete with the fields                                      |
| 9   | Per-record evidence summaries | `codegen/src/support_evidence.rs` (`CameraEvidenceRecord.pipelineVersion` / `schemaVersion` → Swift/TS/C#/JSON/MD camera-support outputs), `capability_summary.rs` per-record blocks in `docs/capability-registry.*`                                                                                                                                                                                                                                 | Delete both members (Section 7.1.6); fails PR 1 compilation if missed |
| 10  | Process rule                  | `CLAUDE.md:291` — "One pipeline-version bump at a time…"                                                                                                                                                                                                                                                                                                                                                                                             | Delete the rule                                                       |
| 11  | Narrative docs                | `docs/pipeline.md` § "Pipeline output version", `docs/caching.md` § "Pipeline output version" (incl. the false closing claim "The counter still drives … the capability registry and qualification evidence"), `docs/testing.md:552–556, 576, 588`, `docs/xmp-canonical-format.md` (the `PIPELINE_OUTPUT_VERSION` schema-note entry), `src/android/README.md:287, 393–395` (stale `.v<N>.avif` claim), `docs/README.md:35` (index summary)           | Rewrite per Section 7.5                                               |

Total footprint on `origin/main`: ~23 files contain the identifier (~58 occurrences), the majority being generators, generated files, and the tests that pin them.

### 4.3 What is _not_ coupled (verified, to prevent scope creep)

- No shared-derivative filename, HTTP parameter/header, ETag, stage target, or R2 key reads the counter (Section 4.1).
- No XMP sidecar field stores the counter; it is "not written to the sidecar" (`docs/xmp-canonical-format.md`). The XMP schema version (`current_schema_version()`) is a separate mechanism — see Decision D2 for why it also leaves the evidence rule, and Section 6 for why nothing else about it changes.
- Pixel output: the counter is a compile-time constant consumed by generators and one smoke string. Deleting it cannot change a single rendered pixel; Section 11 proves this with the colour harness rather than asserting it.

---

## 5. Decisions

### D1 — Delete the counter outright; do not reduce it to a build identifier

Delete `PIPELINE_OUTPUT_VERSION`, its source module, every generator emission, and every generated mirror. The alternative permitted by the issue — "reduce it to a plain build identifier that nothing gates on" — is rejected: a surviving counter is an invitation to re-couple (it has been re-coupled once already, from caches into evidence), and its mirror-consistency tests would keep asserting a number with no consumer. If a future need for a build identity arises, the crate/package version (`CARGO_PKG_VERSION`, already used by `raw-napi`) is the honest source.

### D2 — Evidence records: judge only on what the record measures

Remove both `pipeline_version` and `schema_version` from the evidence rule and from the record format. A record is **satisfied** iff:

1. its corpus hash still matches the files its source declares (`EvidenceSource::corpus`, including `budgets.json` for the colour harness — so tightening a budget already stales the record through the corpus, which is the correct signal), **and**
2. its backend is one the source accepts, **and**
3. `record.expected == source.expected_cases()`, `executed == expected`, both non-zero, **and**
4. `failed == 0` and `skipped == 0`.

Rationale for also removing the schema version (maintainer decision, recorded here): the schema check answered "was this record produced by a build that parses sidecars the same way?" — but every corpus that exercises parsing includes its sidecar fixtures, so a parsing-relevant schema change already moves the corpus hash. Two exceptions were found in review and fixed in the same PR: the two sidecar contract sources originally declared only their test files, so their corpora now also hash the sidecar/XMP implementation they exercise (Apple: the `XMP*`/`Sidecar*` sources in MapleCore; API: `src/api/src/xmp`) — a narrow, per-source implementation set, not a general folding of implementation paths into every corpus, which would bring back the re-recording cascade. As a backstop, a semantics-version bump must re-record both contract suites in the same PR (CLAUDE.md converter rule); and the CI `--check` path (`record.sh --check`) re-runs the suite and compares counts, which is a live check rather than a recorded claim. Keeping the field would preserve a second, weaker serialisation point (every schema bump re-recording five records) for no evidentiary gain. `current_schema_version()` itself is **not** deleted — it remains whatever else uses it; only its role in evidence staleness ends.

Parser compatibility: `EvidenceRecord::from_json` must **ignore** `pipeline_version` / `schema_version` keys when present, so records committed before this change parse cleanly during the transition; the writer simply stops emitting them. `load_bearing()` shrinks to `(source, backend, corpus_hash, expected, executed, failed, skipped)`.

### D3 — No cache key: nothing to design, nothing to change

The maintainer position — "we do not need a cache key" — is already the implemented state (Section 4.1): derivatives are refreshed when the original or its sidecar changes, and a colour-only pipeline change deliberately does not invalidate a shared thumb or preview until that asset is next edited or regenerated. This RFC adopts that as the permanent, documented rule rather than re-litigating it. Any future proposal to reintroduce a derivative version must come with evidence that the stale-until-edited behaviour caused a real defect, and must reckon with the R2 mass-re-upload cost recorded in `thumb-key.ts`.

### D4 — Silent reinterpretation now requires a converter (merge rule)

The counter was, as the issue states, "the only guard" for the case where a stored sidecar value is silently reinterpreted. That guard is replaced by a stronger one, stated as a review-enforceable rule:

> **A change that alters what an already-stored sidecar value means must ship a per-field, load-time converter in the same PR** — a version stamp on the affected field(s) plus a conversion into the current frame on load, following the `papp:WbScaleVersion` pattern (`docs/xmp-canonical-format.md`) with implementations in raw-core and each platform reader, pinned by tests. **No converter, no merge.** A change that merely alters pixel math for values whose meaning is unchanged needs nothing: it is gated by the colour harness and the `budgets.json` ratchet, which are the direct measurement of that change.

This is stronger than the counter ever was: the counter only invalidated derived pixels while _losing_ the authored look; a converter preserves it. Section 10, PR 2 includes a one-time audit of the v1–v29 lineage for reinterpretations that shipped with neither a bump-era converter nor a stamp, filed as follow-ups — they are pre-existing debt, not blockers, because this RFC must not change pixel output.

### D5 — Codegen stays, untouched in scope

The `codegen` crate, `tools/codegen.sh`, and the `codegen-drift` gate remain exactly as they are for every other schema (adjustment model, UI tokens, colour matrices, film catalog, capability registry contents, Android fields, and the rest). Deleting `Schema::PipelineOutputVersion` and the `pipelineOutputVersion` fields removes emissions; it must not reduce coverage of any remaining constant or schema. Acceptance is phrased negatively on purpose: after this change, `codegen-drift` still fails if any _remaining_ generated file is hand-edited.

---

## 6. Non-goals

- **No pixel change.** Any diff in rendered output, in any harness, is a defect in the implementing PR, not an expected consequence.
- **No cache change.** No filename, key, header, ETag, stage target, R2 object, or legacy-rename behaviour changes (Section 4.1). The #4793 test suites must pass unmodified.
- **No change to `current_schema_version()`** or the XMP schema, beyond removing the schema field from evidence records.
- **No nightly move for the colour gates** in this issue. Making `judge()` corpus-only already removes the demotion-on-colour-change; re-recording cadence is a CI-scheduling question for a separate ticket if it is still wanted.
- **No new version-like mechanism** — no build-id key, no content hash, no frozen literal added anywhere. (`FROZEN_R2_KEY_VERSION` and the frozen stage targets are pre-existing #4793 facts and stay as they are.)
- **No Android/Windows behaviour change** beyond deleting a generated constant neither platform reads for a decision (Kotlin `AdjustmentFields.pipelineOutputVersion`, Windows `CapabilityRegistry.g.cs` stamp).

---

## 7. Detailed design

### 7.1 Evidence records (implements D2)

Record format, before → after (`test-fixtures/qualification/<source>.json`):

```jsonc
// before
{ "source": "grey_adjustments", "backend": "cpu-reference",
  "pipeline_version": 29, "schema_version": 5,          // ← both removed
  "corpus_hash": "blake3:…", "expected_cases": 41, "executed_cases": 41,
  "failed_cases": 0, "skipped_cases": 0,
  "git_sha": "…", "recorded_at": "…", "command": "…" }  // informational, kept

// after
{ "source": "grey_adjustments", "backend": "cpu-reference",
  "corpus_hash": "blake3:…", "expected_cases": 41, "executed_cases": 41,
  "failed_cases": 0, "skipped_cases": 0,
  "git_sha": "…", "recorded_at": "…", "command": "…" }
```

Changes, all in `raw-core/src/capability_registry/evidence.rs` unless noted:

1. Delete `BuildIdentity`, `BuildIdentity::current()`, and the `build` field of `Evidence`. This is not a local change: ten emitter call sites read `evidence.build.expect("evidence carries a build identity")` — `codegen/src/capability_registry.rs` (3), `capability_summary.rs` (2), `support_tiers.rs` (2), `support_tiers_cs.rs` (1), `support_tiers_summary.rs` (2) — plus `capability_registry/tests.rs`. Every `build.schema_version` emission at those sites switches to calling `raw_core::capability_registry::current_schema_version()` directly (the same function `qualification_record.rs` already uses). The emitted `build.schema_version` / `schemaVersion` field itself **stays**: it is still asserted (`> 0`) by `CapabilityRegistryTests.swift:67`, `capability-registry.spec.ts:47`, and `CapabilityRegistryTests.cs:58`, and it no longer comes from a record. Only `build.pipeline_version` is deleted. The `let Some(build) = evidence.build else { return Missing }` guard in `judge()` is deleted with the struct.
2. `EvidenceRecord`: remove `pipeline_version` and `schema_version` fields. `from_json` ignores both keys if present (forward/backward tolerance for un-migrated records and for records written by an older `record.sh` during a transition window). `to_json` stops emitting them. `load_bearing()` becomes `(source, backend, corpus_hash, expected, executed, failed, skipped)`.
3. `RecordStatus`: delete `StalePipeline` and `StaleSchema` variants, their `id()` strings (`stale_pipeline`, `stale_schema`), and their `describe()` sentences. **Compatibility note:** these ids appear in the generated capability-registry summaries; removing them is a deliberate output change to `docs/capability-registry.json` / `.md`, committed as regenerated output in the same PR — not a silent break, because no capability currently reports `released` and the findings vocabulary is internal to the registry generator.
4. `judge()`: delete **only** the two version `if` blocks (and the `build` guard from item 1); keep the existing `origin/main` check order exactly: **missing → failed → corpus → backend → vacuous → count → skipped → satisfied**. The failed-before-corpus order is deliberate on main ("Failure is conclusive even when the measured corpus is not installed" — a failing record must report `failed`, not `stale_corpus`, on a machine without the RAW fixtures); reordering it would change `color_harness`'s verdict (Section 10, PR 1).
5. `codegen/src/qualification_record.rs`: remove the `PIPELINE_OUTPUT_VERSION` import and the two stamp lines; `--check` compares on the new `load_bearing()` tuple, so a committed pre-change record and a fresh run agree iff the seven remaining fields agree — meaning **no re-recording is required for the counter/schema decoupling itself**. Note: the two sidecar records were still re-recorded during review — not because the format change required it, but because their corpora were deliberately expanded to include the exercised implementation, which is a new corpus by definition.
6. **Two codegen readers of the record fields, in PR 1's scope:** `codegen/src/support_evidence.rs` formats `r.pipeline_version` / `r.schema_version` into `CameraEvidenceRecord` (`pipelineVersion` / `schemaVersion`) across Swift (`CameraSupport+Generated.swift`), TypeScript (`camera-support.generated.ts`), C# (`CameraSupportRegistry.g.cs`), `docs/camera-support.json`, and `docs/camera-support.md` — delete both members from the record struct on all four surfaces, and update its unit tests (which construct a record with `build.pipeline_version + 1`). `codegen/src/capability_summary.rs` formats the same two fields into each evidence source's per-record block in `docs/capability-registry.md` / `.json` — delete them there too (its `build.*` header emissions are item 1). Leaving either module untouched fails compilation in PR 1; that is intentional — the compiler is the completeness check for this section.

### 7.2 Registry and support build stamps (implements D1, D5)

Remove the `pipelineOutputVersion` / `pipeline_output_version` member from the build-identity block emitted by:

- `codegen/src/capability_registry.rs` — Swift (`CapabilityRegistry+Generated.swift`), TS (`capability-registry.generated.ts`), C# (`CapabilityRegistry.g.cs`);
- `codegen/src/support_tiers.rs` — Swift/TS camera-support stamps (`CameraSupport+Generated.swift`, `camera-support.generated.ts`);
- `codegen/src/support_tiers_cs.rs` — C# `public const uint PipelineOutputVersion` in `src/windows/Maple.WinUI/Generated/CameraSupportRegistry.g.cs`;
- `codegen/src/support_evidence.rs` — the `CameraEvidenceRecord` record members (Section 7.1.6);
- `codegen/src/capability_summary.rs` and `support_tiers_summary.rs` — the JSON/MD `build` object in `docs/capability-registry.json` / `.md` and `docs/camera-support.json` / `.md`, with `build.schema_version` re-sourced per Section 7.1.1.

There is no successor field for the pipeline version (no `buildId`, no git SHA). The build block keeps its `schema_version` / `schemaVersion` member, re-sourced from `current_schema_version()` per Section 7.1.1 — it has independent readers (the three platform tests assert it is `> 0`) and is not part of this retirement. The two web specs (`capability-registry.spec.ts`, `camera-support.spec.ts`) lose only the pipeline equality assertion against the adjustment mirror; the Swift and C# `CapabilityRegistryTests` lose only the pipeline `> 0` / `BuildIdentityIsPositive` assertion. Codegen emitter unit tests that format an expected stamp with `pipelineOutputVersion: 2` are updated to the new expected output.

### 7.3 The counter and its mirrors (implements D1)

Delete, in dependency order:

1. `src/raw-pipeline/raw-core/src/version.rs` (whole module) and `pub use version::PIPELINE_OUTPUT_VERSION;` in `raw-core/src/lib.rs`. The lineage needs no copying: `version.rs`'s own doc comment only reaches v28 (v29, #4730, was recorded in `docs/pipeline.md` but missed in the module), while `docs/pipeline.md` already carries the complete v1–v29 lineage inline. Keep the `docs/pipeline.md` list as the single surviving copy — it is both the history and the audit trail for D4's converter audit (Section 10, PR 2) — and rewrite only the prose around it (Section 7.5).
2. `codegen/src/main.rs`: the `Schema::PipelineOutputVersion` variant and its Swift/TS arms. Delete the `pipeline-output-version` invocation in `tools/codegen.sh` (current line 121) and the generated `MapleCloudKit/Generated/PipelineOutputVersion+Generated.swift`; the Cloudflare TS version file, if still emitted on the target branch, is likewise deleted (verify with `git grep` on the implementation branch — this file's existence has changed across branches before).
3. `codegen/src/adjustment.rs`: the Swift `pipelineOutputVersion` member and TS `PIPELINE_OUTPUT_VERSION` export, including the doc-comment text that instructs bumping ("Bump in `raw_core::version::PIPELINE_OUTPUT_VERSION` whenever…"). Regenerated outputs: `AdjustmentModel+Generated.swift`, `adjustment-model.generated.ts`.
4. `codegen/src/adjustment_api.rs`: the API `PIPELINE_OUTPUT_VERSION` export → regenerated `src/api/src/generated/adjustment-fields.generated.ts`.
5. `codegen/src/android.rs`: the Kotlin `const val pipelineOutputVersion` in `AdjustmentFields` → regenerated `src/android/app/src/main/java/app/justmaple/aperture/generated/AdjustmentFields.kt`.

After `tools/codegen.sh` is re-run, `git status` must show only the intended generated diffs; any other generated file changing means an emitter was disturbed beyond the version field and the PR is wrong.

### 7.4 `raw-napi` smoke export (implements D1)

`maple_napi_version()` exists to prove the addon links the real raw-core graph. Replace the counter with the crate version alone:

```rust
#[napi]
pub fn maple_napi_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
```

If reviewers want the link-proof to keep touching a raw-core symbol beyond the crate root, reference any stable existing constant (for example a UI-token or colour-matrix constant) — but do not invent a replacement version constant. Update the function's doc comment so the next reader does not go looking for a pipeline version. Any JS/TS test that matches the `"(raw-core pipeline output v…)"` suffix is updated to the new string.

### 7.5 Documentation (implements D2, D3, D4)

| File                                                                                                                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/pipeline.md` § "Pipeline output version"                                                                                        | Replace the section's framing prose with a short retirement note: the counter existed #1926–#5007, was retired because derivatives no longer key on it (#4793) and evidence no longer gates on it; state the D4 converter rule. Keep the inline v1–v29 lineage list already in this section verbatim — it is more complete than `version.rs`'s (which stops at v28) and becomes the only copy.                                                                                                                                                       |
| `docs/caching.md` § "Pipeline output version"                                                                                         | Retitle to reflect that there is no pipeline version. Keep every #4793 statement (unversioned names, no `pv`, frozen R2 `/v25`, frozen stage targets, rename-on-miss). Delete the closing claim that the counter "still drives … the capability registry and qualification evidence". State D3 plainly: a colour-only change does not invalidate a shared derivative until the asset's original or sidecar changes. **If the heading is retitled, update the `(#pipeline-output-version)` anchor linked from `docs/caching.md:5` in the same edit.** |
| `docs/testing.md` (state rule, ~line 552; registry-demotion passage, ~556; recording passage, ~576; camera `qualified` passage, ~588) | Rewrite the satisfied rule to the D2 four-condition form. Remove "bumping `PIPELINE_OUTPUT_VERSION`" from the list of demoting events (corpus edits, `budgets.json` edits, and record deletion remain). Note that `record.sh --check` still re-runs suites live in CI; only the recorded-version staleness is gone.                                                                                                                                                                                                                                  |
| `docs/xmp-canonical-format.md`                                                                                                        | Remove the `PIPELINE_OUTPUT_VERSION` entry from the schema-notes list. Add one sentence to the `WbScaleVersion` section cross-referencing the D4 rule: per-field stamps are now the _only_ sanctioned mechanism for reinterpretation.                                                                                                                                                                                                                                                                                                                |
| `CLAUDE.md`                                                                                                                           | Delete the "One pipeline-version bump at a time" bullet (line 291) in full — the serialisation, the `gh pr list` pre-flight, and the "take the next free version" instruction. Add the D4 converter rule where colour-pipeline guidance lives, so the replacement guard sits where contributors will actually read it before a colour change.                                                                                                                                                                                                        |
| `docs/capability-registry.md` / `.json`, `docs/camera-support.md` / `.json`                                                           | Regenerated by `tools/codegen.sh` (build stamp loses the field; no capability state should change as a result of PR 1 — see Section 11). Commit as generated output.                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/android/README.md` (lines 287, 393–395)                                                                                          | Correct the stale claim that Android cache keys and `.maple/` derivatives use `.v<N>.avif` "where `<N>` is the generated pipeline output version" — already false since #4793, and doubly so after this RFC. Align with the unversioned naming in `docs/caching.md`. (Doc-only fix; it rides in PR 2 because it names the counter, not because Android behaviour changes.)                                                                                                                                                                           |
| `docs/README.md` (line 35)                                                                                                            | Drop "the pipeline output version" from the `pipeline.md` summary row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 8. Alternatives considered and rejected

| Alternative                                                                            | Why rejected                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reduce the counter to a plain build identifier that nothing gates on (issue-permitted) | Keeps the mirror surface and its consistency tests for zero consumers; history shows an ungated counter gets re-gated. D1.                                                                                                                                                                                     |
| Key shared derivatives on the app build id                                             | Reintroduces per-release mass invalidation across every shared library and the R2 edge cache — the exact cost #4793 removed — to solve a problem (stale-until-edited) the maintainer has accepted. D3.                                                                                                         |
| Freshness-only derivative keys (mtime in filename/URL)                                 | Already the de facto rule for Apple's local cache and unnecessary for shared derivatives, whose readers stat the asset anyway; adds a key where the maintainer decision is "no cache key".                                                                                                                     |
| Freeze `.v<N>` at 29 as a permanent literal                                            | A frozen version number in a filename is a lie future contributors will try to bump; #4793 already chose unversioned names.                                                                                                                                                                                    |
| Keep schema version in evidence records, drop only pipeline version                    | Preserves a second serialisation point (schema bump ⇒ five re-recordings) whose evidentiary value is already covered by corpus hashes and live CI `--check`. D2 records the maintainer's decision to drop both.                                                                                                |
| Move colour gates to a nightly run instead of decoupling                               | Treats the symptom (demotion noise) while keeping the coupling that serialises PRs; also out of scope per the issue's acceptance ("a colour change no longer needs … five re-recorded records" — nightly re-recording still needs them, just less visibly). May be proposed separately for scheduling reasons. |
| Keep the counter, exempt colour-only changes from bumping by policy                    | Unenforceable: "colour-only" is exactly the judgement call the bump policy already fails at ("when in doubt, bump"), and the evidence rule cannot distinguish the two cases.                                                                                                                                   |

---

## 9. Risks and mitigations

| Risk                                                                                                                                           | Severity                                         | Mitigation                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A future silent reinterpretation ships with no converter, and old sidecars render differently forever — the #1733/#1083 failure mode returning | High (the only real regression risk in this RFC) | D4 as a written merge rule in `CLAUDE.md` where colour work is reviewed; the v1–v29 audit (PR 2) names the historical cases so reviewers have concrete examples; XMP schema review already covers new/changed fields. Residual risk accepted explicitly by the maintainer decision in #5007 ("Stored sidecar values that are silently reinterpreted still need a load-time converter"). |
| Evidence records stay "satisfied" after a genuine colour regression, so the registry overstates confidence                                     | Medium                                           | The records never measured colour correctness directly for this purpose — the colour harness's corpus includes `budgets.json`, so a regression caught by tightened budgets, or any corpus change, stales the record. Pixel correctness remains gated per-PR by `test_color_pipeline.sh`, not by the registry.                                                                           |
| Deleting generated fields breaks an out-of-tree or in-flight consumer                                                                          | Low                                              | Full-repo `git grep` on `origin/main` shows no production reader (Section 3.3); in-flight PRs touching generated files rebase through `tools/codegen.sh` as usual. The deletions are field removals in generated files, so conflicts resolve by regenerating, never by hand-merging.                                                                                                    |
| `StalePipeline`/`StaleSchema` status ids disappear from generated registry summaries that something downstream parses                          | Low                                              | The ids are produced only by the registry generator and consumed only by its generated summaries; grep confirms no external parser. Noted as a deliberate output change in PR 1's description.                                                                                                                                                                                          |
| The retirement PR itself triggers the cascade one last time (record migration misread as drift)                                                | Low                                              | D2's parser tolerance + `load_bearing()` comparison is designed so the migration needs no re-recording (Section 7.1.5); PR 1's CI run is the test of that claim. If `record.sh --check` disagrees, the fallback is a one-time re-record of the five CI-gated records — annoying, not blocking, and the last one ever.                                                                   |
| Stale-checkout implementation: building this on a branch that predates #4793 resurrects `.v<N>` filenames and the R2 coupling                  | High if ignored                                  | Plan Step 0 (Section 10) mandates a fresh branch off current `origin/main` and a pre-flight `git grep` to confirm the Section 4.1 state before any edit. This already happened once during drafting and is why the audit is pinned to `b9b5f75519`.                                                                                                                                     |

---

## 10. Implementation plan

Two PRs, in order. PR 1 is independently mergeable and delivers the user-visible win (no more cascade). PR 2 deletes the now-unreferenced counter. Splitting this way means PR 2 is a pure deletion whose greenness proves D1's premise — if anything still needed the counter, PR 2's build is where it would say so.

### Step 0 — Pre-flight (both PRs)

- [ ] Create the implementation branch fresh off current `origin/main`. Do not reuse or rebase any branch that predates #4793.
- [ ] Re-run the audit on the branch tip and confirm Section 4 still holds:
      `git grep -n "PIPELINE_OUTPUT_VERSION" | wc -l` (≈58 at `b9b5f75519`) and
      `git grep -n "FROZEN_R2_KEY_VERSION" src/api/src/cloudflare/thumb-key.ts` (must exist).
      If the count has moved materially, update Section 4.2's table in the PR description before proceeding.
- [ ] Confirm every PR description carries `Closes #5007` (PR 2) per repo convention, and both PRs are opened ready-for-review, not draft.

### PR 1 — Decouple evidence from the counter

_Scope: Section 7.1 + 7.2 + the registry-test updates. No counter deletion yet — the constant becomes unread by evidence but still exists, so PR 1 cannot break any mirror._

- [ ] `evidence.rs`: delete `BuildIdentity` and `Evidence.build`; remove both version fields from `EvidenceRecord`; tolerant `from_json`; shrink `load_bearing()`; delete `StalePipeline`/`StaleSchema`; in `judge()` delete only the two version blocks and the `build` guard, preserving the main check order failed → corpus → backend → vacuous → count → skipped (Section 7.1).
- [ ] All ten `evidence.build.expect(...)` emitter sites (`capability_registry.rs`, `capability_summary.rs`, `support_tiers.rs`, `support_tiers_cs.rs`, `support_tiers_summary.rs`): `build.schema_version` → `current_schema_version()`; delete `build.pipeline_version` (Section 7.1.1).
- [ ] `qualification_record.rs`: stop stamping both fields.
- [ ] `support_evidence.rs` (`CameraEvidenceRecord` members, all four output surfaces) and `capability_summary.rs` per-record blocks: delete both record fields; update their unit tests (Section 7.1.6).
- [ ] Migrate committed records: strip `pipeline_version`/`schema_version` keys from **exactly the eight committed `<source>.json` files** — `grey_adjustments`, `synthetic_grey`, `grey_dcp`, `color_chart`, `color_harness`, `sidecar_contract_apple`, `sidecar_contract_api`, `gpu_chain_parity_metal` (the `EvidenceSource::ALL` sources with a committed record; `gpu_chain_parity_lavapipe` and `apple_canvas_golden` have none). Do **not** glob `test-fixtures/qualification/*.json`: that directory also holds historical ad-hoc artifacts (per-ticket manifests, `windows-*/manifest.json`, nested `canonical_record.pipeline_version`) that are evidence _history_, not records, and must not be rewritten. No other key changes. The eight records need no re-recording for the key removal itself; the two sidecar records were additionally re-recorded against their (deliberately expanded) corpora during review.
- [ ] Codegen emitters (`capability_registry.rs`, `support_tiers.rs`, `support_tiers_cs.rs`, `capability_summary.rs`, `support_tiers_summary.rs`): remove the build-stamp field (Section 7.2); update emitter unit tests.
- [ ] Run `tools/codegen.sh`; commit regenerated Swift/TS/C# registry + support files and `docs/capability-registry.*`, `docs/camera-support.*`. **Expected — capability states unchanged, three finding statuses change** (this corrects an earlier draft of this plan, which implied nothing changes): every top-level capability stays `core` (other required surfaces/sources are still missing), but three non-CI-gated records leave `stale_pipeline`:

  | Record (on `origin/main`)                                                          | Before           | After                  | Why                                                                                                                                                                                                                                                                                 |
  | ---------------------------------------------------------------------------------- | ---------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `sidecar_contract_apple` (`pipeline_version: 19`, corpus matches, 12/12, 0 failed) | `stale_pipeline` | `satisfied`            | Version was the only failing check                                                                                                                                                                                                                                                  |
  | `color_harness` (`pipeline_version: 24`, `failed_cases: 92`)                       | `stale_pipeline` | `failed` ("92 failed") | Failed is checked before corpus on main (Section 7.1.4); this propagates into `docs/capability-registry.*` and every fixtured camera's qualification array in `docs/camera-support.*`, `CameraSupport+Generated.swift`, `camera-support.generated.ts`, `CameraSupportRegistry.g.cs` |
  | `gpu_chain_parity_metal` (`pipeline_version: 24`, corpus hash outdated)            | `stale_pipeline` | `stale_corpus`         | Corpus is now the first failing check                                                                                                                                                                                                                                               |

  These three transitions are the _point_ of the change (records now report their real status), not a regression. Any _other_ state or finding change in this PR must be explained, not waved through.

- [ ] Update the two web specs, `CapabilityRegistryTests.swift`, and `CapabilityRegistryTests.cs` (remove the pipeline mirror-equality / `BuildIdentityIsPositive` assertions; keep the `schemaVersion > 0` assertions — the field survives, re-sourced). Update the Rust test modules that construct the deleted types: `capability_registry/tests.rs`, `support_tiers/tests.rs`, `capability_registry/color_corpus/tests.rs`. Add/adjust the Rust registry test: _a record that would previously have been `StalePipeline` is `Satisfied` when corpus, backend, and counts match._
- [ ] Docs in this PR: `docs/testing.md` rule rewrite (Section 7.5) — it describes PR 1's behaviour and must not lag it.

**PR 1 exit criterion:** a no-op colour change (for example a comment-free AgX coefficient tweak reverted before merge, or simply the next real colour PR after this lands) requires no record re-recording and demotes nothing. Demonstrate once in the PR by running `record.sh --check` for the five CI-gated sources against the migrated records.

### PR 2 — Delete the counter

_Scope: Sections 7.3, 7.4, remaining 7.5 docs, lineage audit._

- [ ] Fold the condensed v1–v29 lineage into `docs/pipeline.md`, then delete `version.rs` + the `lib.rs` re-export (Section 7.3.1).
- [ ] `codegen/src/main.rs`: delete `Schema::PipelineOutputVersion`; `tools/codegen.sh`: delete its invocation; delete `PipelineOutputVersion+Generated.swift` (and the Cloudflare version TS file if present on the branch).
- [ ] `adjustment.rs`, `adjustment_api.rs`, `android.rs`: remove the field/emissions (Sections 7.3.3–7.3.5); re-run `tools/codegen.sh`; commit only the intended generated diffs (Section 7.3, final note).
- [ ] `raw-napi`: repoint `maple_napi_version()` per Section 7.4; fix its doc comment and any string-matching test.
- [ ] Delete/update remaining pinning tests not already handled in PR 1 (codegen emitter tests in `adjustment.rs` test module, `adjustment_tables.rs`'s `assert!(!out.contains("PIPELINE_OUTPUT_VERSION"))` becomes vacuous — delete it).
- [ ] Docs: `CLAUDE.md` serialisation bullet deleted and D4 rule added; `docs/pipeline.md`, `docs/caching.md`, `docs/xmp-canonical-format.md` per Section 7.5.
- [ ] **Lineage audit:** walk the v1–v29 lineage preserved in `docs/pipeline.md`; for each bump whose description is a reinterpretation of a stored value (slider direction flips, scale moves, formula redefinitions) rather than pure pixel math, check whether a per-field converter/stamp exists today. File one follow-up issue per unconverted case (or one umbrella issue listing them), each labelled as pre-existing debt. Do not fix any in this PR — pixel changes are forbidden here (Section 6).
- [ ] Final negative greps (Section 11).

**PR 2 exit criterion:** `git grep -n "PIPELINE_OUTPUT_VERSION\|pipelineOutputVersion\|pipeline_output_version"` on the merged tree returns only (a) the retirement note and lineage appendix in `docs/pipeline.md`, (b) the frozen-literal comments from #4793 that mention the counter by name to forbid it (`thumb-key.ts`, `preview-cache-protocol.ts`, `derivative-versions.ts`) — these stay; they are warnings, not couplings — (c) this RFC, and (d) **historical documents that are never edited**: `docs/strategy/milestones/m4-color-output.md:79` (a milestone proposal that suggested adding such a field to harness output) and the per-ticket qualification artifacts under `test-fixtures/qualification/` (`windows-as-shot-reset335/history339-manifest.json`, `windows-keyboard337/manifest.json`, and ad-hoc files with a nested `canonical_record.pipeline_version`). Those are dated evidence of what was run at the time; rewriting them would falsify the record. Any _code, generated file, live doc, or committed `<source>.json` record_ still matching is a miss.

### Sequencing note

PR 2 depends on PR 1 (deleting the constant while evidence still reads it would not compile) but on nothing else. No other in-flight work needs to wait: PR 1 removes the serialisation rule's _reason_ at merge time, and `CLAUDE.md` is updated in PR 2 — so between PR 1 and PR 2, contributors should be told (in PR 1's description and the team channel) that bumps are already unnecessary, even though the constant still exists briefly.

---

## 11. Validation plan

| #   | Check                                                 | Command / procedure                                                                                                                        | Expected evidence                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Rust core + registry                                  | `cargo test -p raw-core --lib`                                                                                                             | All pass, including the new corpus-only satisfaction test (PR 1)                                                                                                                                                                                                                                                                                |
| 2   | Codegen                                               | `cargo test -p codegen`                                                                                                                    | All pass with updated emitter expectations                                                                                                                                                                                                                                                                                                      |
| 3   | Codegen drift (the acceptance gate for D5)            | `tools/codegen.sh` then `git diff --exit-code`                                                                                             | Clean; and a deliberate hand-edit to any remaining generated file still fails the same gate in CI (`codegen-drift` job)                                                                                                                                                                                                                         |
| 4   | Evidence migration needs no re-record                 | `tools/qualification/record.sh --check` for `synthetic_grey`, `color_chart`, `grey_adjustments`, `grey_dcp`, `sidecar_contract_api` (PR 1) | All five match the migrated committed records                                                                                                                                                                                                                                                                                                   |
| 5   | Registry state unchanged by PR 1, three findings move | Diff `docs/capability-registry.json` + `docs/camera-support.json` before/after regeneration                                                | Build stamp loses `pipeline_output_version` (keeps `schema_version`); zero capability **state** changes; exactly the three expected finding transitions from Section 10 PR 1 (`sidecar_contract_apple` → `satisfied`, `color_harness` → `failed`, `gpu_chain_parity_metal` → `stale_corpus`). Any fourth change is explained or the PR is wrong |
| 6   | API                                                   | `cd src/api && bun test`                                                                                                                   | Pass; cache/derivative suites **unmodified** (Section 6)                                                                                                                                                                                                                                                                                        |
| 7   | Web                                                   | `bun x ng test maple-common`                                                                                                               | Pass with the two updated specs                                                                                                                                                                                                                                                                                                                 |
| 8   | Apple                                                 | `cd src/apple/Packages/MapleCore && swift test`                                                                                            | Pass with updated `CapabilityRegistryTests` (requires the xcframework per `AGENTS.md`; if unavailable in the environment, state so and rely on CI — do not claim the pass)                                                                                                                                                                      |
| 9   | Android / Windows                                     | Platform test suites for the generated-field consumers (Kotlin compile at minimum)                                                         | Pass; neither platform referenced the deleted constant for a decision                                                                                                                                                                                                                                                                           |
| 10  | Zero pixel change                                     | `FILTER=baseline src/scripts/test_color_pipeline.sh`                                                                                       | All baseline cases within existing budgets, unchanged from `origin/main`. Fixture-gated skip-pass is acceptable only if fixtures are genuinely absent locally, and must be reported as a skip, not a pass; CI with fixtures is the deciding run                                                                                                 |
| 11  | Cache non-regression (proves Section 4.1 untouched)   | The #4793 suites: preview/thumb path contract, `cache-gc`, R2 `thumb-key`, legacy rename-on-miss                                           | Pass with zero modifications to those test files across both PRs (`git diff --stat` on the test paths is empty)                                                                                                                                                                                                                                 |
| 12  | Negative grep                                         | `git grep -n "PIPELINE_OUTPUT_VERSION\|pipelineOutputVersion\|pipeline_output_version"`                                                    | Only the four permitted categories in PR 2's exit criterion (retirement note/lineage, #4793 forbidding comments, this RFC, unedited historical artifacts)                                                                                                                                                                                       |
| 13  | The headline acceptance test                          | After both PRs: open a trivial colour-only PR (or re-run the harness locally with a coefficient nudged and reverted)                       | No version to bump, no record to re-record, `codegen-drift` green, no `CLAUDE.md` rule to consult                                                                                                                                                                                                                                               |

Checks 5, 11, and 13 are the ones that distinguish this RFC being _implemented_ from it being _approximated_; a PR that skips them has not demonstrated the acceptance criteria.

---

## 12. Rollout and rollback

- **Rollout.** Two ordinary PRs, each rebase-and-merge per repo convention, no feature flag, no migration window. PR 1's record migration is a pure key-stripping diff to JSON files; PR 2 is a deletion plus regeneration. No user data, sidecar, cache, or R2 object is touched at any point, so there is nothing to roll out to users.
- **Rollback.** Revert either PR independently. Reverting PR 1 restores version-gated evidence (the migrated records, having lost the keys, would parse under the old `from_json` only if it supplies defaults — it does not; so a PR 1 revert must also restore the record keys from git history, which the revert does automatically since both changes are in the same commit range). Reverting PR 2 restores the constant at its last value (29) and its mirrors by regeneration. Neither rollback requires cache or bucket action.
- **In-flight PRs** that bump the counter to 30 while this RFC is in flight: they may merge normally before PR 1; after PR 1 they must drop the bump hunk on rebase (it will conflict in `version.rs` only if PR 2 has landed, otherwise it merges harmlessly and the bump is simply never read). No coordination beyond PR 1's announcement (Section 10, sequencing note).

---

## 13. Acceptance mapping (#5007)

| Issue acceptance / constraint                                                            | Where satisfied                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "No open-PR serialisation rule for version bumps"                                        | `CLAUDE.md:291` bullet deleted (PR 2); the rule's mechanism removed in PR 1                                                                                                                                                       |
| "A colour change no longer needs a version bump"                                         | Counter deleted (PR 2); no successor mechanism (D1, Section 6)                                                                                                                                                                    |
| "…or five re-recorded records"                                                           | Corpus/backend/count-only `judge()` (PR 1, D2); validation check 4 and 13                                                                                                                                                         |
| "`codegen-drift` still passes and still covers every cross-language constant and schema" | D5; validation check 3 (including the Android emitter)                                                                                                                                                                            |
| "The replacement staleness rules for caches and evidence are documented"                 | Evidence: Section 7.1/D2 + `docs/testing.md` rewrite. Caches: no replacement rule is introduced — the documented rule is #4793's (no key; refresh on original/sidecar change), restated in `docs/caching.md` per Section 7.5 (D3) |
| "Thumbnails and previews are already decoupled (#4793); keep it that way"                | Section 4.1 audit; non-goal in Section 6; validation check 11 requires the #4793 suites to pass unmodified                                                                                                                        |
| "Stored sidecar values that are silently reinterpreted still need a load-time converter" | D4 merge rule in `CLAUDE.md` + `docs/xmp-canonical-format.md`; PR 2 lineage audit files follow-ups for historical cases                                                                                                           |
| "Do not change pixel output in this ticket"                                              | Section 6 non-goal; validation check 10                                                                                                                                                                                           |

---

## Appendix A — Audit commands (reproducible)

Run against the implementation branch tip; results at `b9b5f75519` are quoted in Section 4.

```bash
git fetch origin
git grep -n "PIPELINE_OUTPUT_VERSION" origin/main            # ~58 hits, ~23 files
git grep -n "pipelineOutputVersion" origin/main              # Swift/Kotlin mirrors + specs
git show origin/main:src/raw-pipeline/raw-core/src/version.rs | grep "pub const"
#   → pub const PIPELINE_OUTPUT_VERSION: u32 = 29;
git show origin/main:src/api/src/workers/derivative-versions.ts
#   → frozen 29, decoupled (#4793)
git show origin/main:src/cloudflare/src/r2.ts | grep -A3 "thumbR2Key"
#   → frozen /v25, no counter
git show origin/main:CLAUDE.md | grep -n "pipeline-version bump"
#   → line 291, the serialisation rule
```

## Appendix B — Lineage note

The complete v1–v29 bump lineage already lives inline in `docs/pipeline.md` (§ "Pipeline output version"); `version.rs`'s own doc comment stops at v28 — v29 (#4730, per-channel black levels for LinearRaw and X-Trans) was recorded in the docs but missed in the module. PR 2 therefore keeps the `docs/pipeline.md` list as the sole surviving copy and deletes `version.rs` without transcribing anything (Section 7.3.1). The lineage is not reproduced in this RFC either: a third copy is guaranteed to drift — which is, in miniature, the problem this RFC exists to remove.

# Pipeline-Output Version

Maple's develop pipeline is deterministic: a given `(RAW file, XMP sidecar)`
pair renders to one specific image. Several caches lean on that determinism to
avoid recomputing pixels — the Apple rendered-preview cache, the decoded-buffer
cache, the deep-zoom tile cache, and the Web thumbnail cache all store a
previously-produced artifact and serve it again when the same input reappears.
That shortcut is only safe while the pipeline that produced the artifact still
agrees with the pipeline running today. When a color-math change, a demosaic
retune, an AgX LUT revision, or a silent reinterpretation of a stored slider
value moves the output, every artifact produced before that change is stale, and
a cache that cannot tell the difference will serve the old pixels indefinitely.

`PIPELINE_OUTPUT_VERSION` is the single value that lets every cache tell the
difference. It is a monotonically increasing `u32` defined once in raw-core and
mirrored into the platform languages by codegen, and it exists so that one edit
in one place invalidates stale derived artifacts everywhere at once.

## What the constant means

The canonical definition lives at
`src/raw-pipeline/raw-core/src/version.rs` as
`raw_core::version::PIPELINE_OUTPUT_VERSION`, re-exported at the crate root as
`raw_core::PIPELINE_OUTPUT_VERSION`. Its value is the version of _what pixels the
develop pipeline produces for a given input_. Two distinct kinds of change move
it, and both were shipping without any version signal before ticket #1926:

- A pixel-math change made with the stored `AdjustmentModel` held fixed. A new
  AgX LUT, a demosaic algorithm change, a DCP colorimetry correction, or a
  white-balance solve revision all render the same stored numbers to different
  pixels. The numbers still mean what they always meant; the pipeline simply
  produces a different result from them.
- A silent reinterpretation of a stored slider value, where the same stored
  number renders differently because the formula that consumes it changed. Two
  historical examples name the pattern: #1733 moved HSL saturation near the
  gamut hull from a hard clip to a soft-compress, so an old
  `saturation_adjustment_*` value renders differently than when it was authored;
  and #1083 changed the capture-sharpening radius from `radius.round()` to a
  real sigma-to-box-width derivation, so the same stored radius sharpens
  differently before and after. Neither recorded the boundary at which the
  meaning changed.

## Relationship to `wb_scale_version`

`PIPELINE_OUTPUT_VERSION` generalizes the pattern that `wb_scale_version`
(`raw_core::types::WbScaleVersion`) had solved for exactly one field. The two are
complementary tools for the same class of problem rather than duplicates of each
other, and understanding the split is the point of this document.

A `wb_scale_version` stamp is the rich tool. It is written into each sidecar and
records the exact scale that a stored `crs:Temperature` / `crs:Tint` pair was
authored under, so the develop chain can _convert_ an old value into the current
frame at load time and preserve the authored look exactly. That per-field
provenance stamp earns its keep when preserving the pre-change look is worth the
cost of writing and maintaining a converter — as it was for the white-balance
value mapping, where a user's chosen temperature and tint had to keep looking the
way they chose across four scale revisions.

`PIPELINE_OUTPUT_VERSION` is the cheaper default for every change where a
converter is not written, which is the common case. It converts nothing and
preserves nothing about the pre-change look. It simply invalidates every derived
artifact so a fresh render replaces the stale one. As #1926 frames it, a version
bump after the fact is still better than an indefinitely silent reinterpretation:
#1733 and #1083 are exactly the changes that should have moved this counter and
had nothing to move, because no cache keyed on a canonical version yet. Once the
adopters below key on it, the first render after any bump quietly discards the
stale entry, including any lingering entries produced under the pre-#1733 or
pre-#1083 semantics.

## The bump policy — the #1926 decision

A raw-core change increments `PIPELINE_OUTPUT_VERSION` by one, in the same commit
as the pipeline edit, whenever that edit alters the pixel output of the develop
pipeline for any input, or silently reinterprets an already-stored
`AdjustmentModel` value without a load-time converter.

Some changes deliberately do not move it. Adding a new slider that sits at an
identity default has no effect on any existing sidecar and so changes no output.
Fixing a bug that has no output-visible effect changes nothing a cache can
observe. A change to an estimator that only runs when no value is authored —
which is what #1870's As-Shot tint seed turned out to be on closer reading, per
the #1926 discussion — reinterprets no stored value and so does not qualify
either.

When the call is genuinely unclear, bumping is the safe direction. A spurious
bump costs one cache miss per asset and a single re-render; a missed bump serves
stale pixels for as long as the cache entry survives.

## How it reaches the caches

The constant is single-sourced in raw-core and emitted by the `codegen` crate,
driven by `tools/codegen.sh`, into the platform mirrors alongside the rest of the
`AdjustmentModel` shape:

- Swift receives `AdjustmentModel.pipelineOutputVersion` (a `UInt32`) in
  `AdjustmentModel+Generated.swift`.
- TypeScript receives `PIPELINE_OUTPUT_VERSION` (a `number`) in
  `adjustment-model.generated.ts`.

Because both mirrors are generated from the one raw-core constant, the number
cannot drift between languages, and the `codegen-drift` CI job
(`.github/workflows/cross.yml`) fails if a hand edit to a generated file tries to
change it out of band. A raw-core author who changes pipeline output edits the
`version.rs` constant, runs `tools/codegen.sh`, and commits the regenerated Swift
and TypeScript together — the same workflow every other single-sourced constant
already follows.

Each rendered-output cache consumes the mirror by folding it into its cache key.
Keying on the version is what turns a single bump in raw-core into an
invalidation across Apple and Web simultaneously, with no per-cache code change
required at bump time.

## Adopters

Two caches key on the constant today, and they are the reason #1926 landed ahead
of them:

- The Web Hosted thumbnail cache (#1927). A Hosted thumb is a full WASM develop
  through the raw-core/AgX chain, so a raw-core or view-transform change alters
  its pixels. `MapleCacheService` version-guards each locally-developed thumb
  with a `<sha>.jpg.v` companion marker recording its
  `THUMB_PIPELINE_VERSION`; that constant is now sourced directly from the
  TypeScript mirror (`THUMB_PIPELINE_VERSION = PIPELINE_OUTPUT_VERSION`), so a
  bump moves it ahead of every existing marker and previously-developed thumbs
  re-develop. A foreign, unmarked thumb (server or native embedded extraction,
  pipeline-independent) is still trusted as-is.
- Apple's rendered-preview cache (#1928). `RenderedPreviewCache` folds the Swift
  mirror `AdjustmentModel.pipelineOutputVersion` into its key alongside the
  `primaryMtime` and `sidecarMtime` components, as a `pv<version>` field in the
  pre-hash variant token.

On Apple the constant supersedes, going forward, the hand-maintained,
drift-prone per-cache version fields that predate it —
`RenderedPreviewCache.viewTransformVersion`, `DecodedBufferCache.rustVersion`,
and `TileManager.viewTransformVersion`. These are per-instance `private let`
fields, not statics. `RenderedPreviewCache` keeps its local
`viewTransformVersion` for the documented bump lineage recorded in that file, but
new pipeline-output changes bump this single source instead of a local integer,
so a raw-core output change can no longer ship without invalidating the caches.
Because the value is a constant today, folding it into a key changes nothing at
steady state; it only bites when the version is bumped on a future pipeline
change.

See `docs/caching.md` for how the individual cache layers are structured and
where each key is built.

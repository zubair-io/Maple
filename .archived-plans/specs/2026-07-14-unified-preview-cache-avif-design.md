# Unified Display-Preview Cache — Canonical Derivative + Versioning Spec

**Date:** 2026-07-14
**Status:** Proposed (Stage 2 of the 6-stage plan tracked as epic #1993 — the original
plan document lived only in a local Claude Code plan-mode session and was never
committed to the repo; #1993 and its stage sub-issues #1994–#1999 are the durable,
in-repo record of that plan's content)
**Platforms:** Rust core (`src/raw-pipeline/`), Bun/Elysia server (`src/api/`), Angular web
(`src/web/`), Swift/SwiftUI Apple app (`src/apple/`)
**Depends on:** Stage 1 (`cache-gc.ts` orphan-regex fix — shipped, commit `99cfc4d23`)
**Blocks:** Stage 3 (`maple_id` derivation), Stage 4 (implementation)

## Summary

This is Stage 2 of the approved plan to unify the "display preview" cache tier — the
image the Preview screen swaps in over the grid thumbnail while the full RAW loads —
across Apple, the self-hosted server, and Web, and move it from JPEG to AVIF. Today
there is no single tier: three artifacts exist, with different keys, different sizes,
different formats, and zero cross-process awareness. This document **chooses** the
canonical pixel recipe and the version/publish contract those three producers must
converge on, and specifies Apple's local-only edited-preview contract precisely enough
to implement without further design decisions. Per the plan's mandate, nothing here is
left as "TBD" or deferred to a later stage; where a question genuinely cannot be
resolved from the current codebase, it is called out explicitly in [Open
Questions](#open-questions), not silently assumed.

Every factual claim below was checked directly against `origin/main` in this session
(fetched fresh; working tree confirmed current) — file paths, line-level behavior, and
existing constants are cited so Stage 4 can verify them again independently.

## Non-goals (owned by other stages / other epics)

- **`maple_id` derivation mechanics** (streaming hasher, SMB range-reads, id-cache
  persistence) — Stage 3. This spec assumes `maple_id` becomes available on Apple as an
  input, without designing how.
- **Edited/developed-preview cross-platform sharing** — explicit Stage 6 follow-on epic.
  This spec's canonical tier is unedited-only; Apple's local edited-preview contract
  (§3) is a stopgap that keeps edited pixels out of the shared tier, not a design for
  sharing them.
- **Thumbnail cache-key migration to `maple_id`** — separate future epic. The 256px
  `.maple/thumbs/*` tier is untouched by this plan in every stage, this spec included.
- **The server's own developed-preview tier** (`<maple_id>_dev_<sidecar_ver>.jpg`,
  written by `src/api/src/workers/stages/display-preview.ts`, served via
  `developedPreviewResponse` in `src/api/src/routes/library/shared.ts`). This is a
  distinct, already-shipped, DB-versioned artifact for edited assets on the
  self-hosted backend. It stays JPEG and is not renamed by this spec — see the
  boundary note in §3.
- **`cachePathForAsset`/`cachePathFor`'s API shape** (artifact-kind enum vs.
  string kind+size). The plan flags this as Stage 4 implementation work; this spec
  states the constraint the new tier's path must satisfy (§2.1) without redesigning
  the resolver function.
- Designing the Stage 5 test harness itself — §4 enumerates the acceptance criteria
  this spec commits Stage 5 to, not the harness code.

## Grounding: what's actually on `main` today

This section exists because the plan's own history shows unverified claims caused real
rework (three review rounds, a stale-worktree bug). Everything here was read directly,
not inferred from the plan's prose.

**Three non-interoperable producers today, confirmed:**

1. **Apple** (`src/apple/Packages/MapleCore/Sources/MapleCore/Cache/ThumbnailLoader+DisplayPreview.swift`,
   full file read). Key: `MapleSidecarPaths.previewURL` →
   `<assetDir>/.maple/previews/<sha256prefix16(basename)>_1600.jpg`. Recipe:
   ImageIO `CGImageSourceCreateThumbnailAtIndex` with
   `kCGImageSourceCreateThumbnailFromImageIfAbsent: false` for RAW (embedded preview
   only, **never** a full Apple-RAW decode — the doc comment is explicit this would
   diverge from the Maple pipeline), falling through to a real ImageIO decode+resize
   for non-RAW bitmaps whose embedded thumb is under 1024px long edge. JPEG, quality
   0.82 (`previewJpegQuality`), sRGB via `CGColorSpace(name: CGColorSpace.sRGB)!`.
   Versioned by a sibling `<key>_1600.v` marker (#1976,
   `displayPreviewMarkerIsCurrent`/`writeDisplayPreviewMarker`) — **this key scheme is
   NOT `maple_id`**, it's a different hash than the server uses for the same asset, so
   today Apple and server literally cannot address the same file for the same photo,
   independent of format.
2. **Server, self-hosted** (`src/api/src/indexer/previewer.ts`, full file read; served
   by `src/api/src/routes/library/preview.ts` and `src/api/src/routes/fs-previews.ts`).
   Key: `cachePathForAsset(asset, libs, 'previews', '1280')` →
   `<library_root>/<fileinfo[0].path>/.maple/previews/<maple_id>_1280.jpg`. Recipe for
   RAW: FFI extern `maple_render_thumbnail_preview_jpeg_to_file` (embedded preview,
   never a full develop), JPEG quality 85. Recipe for bitmaps
   (JPEG/PNG/TIFF/PSD/HDR/HEIC): `renderBitmapPreviewToFile` → `sharp(...).rotate()`
   (bakes EXIF orientation) `.resize(1280, 1280, {fit:'inside', withoutEnlargement:
true})` → JPEG quality 82 (`mozjpeg: true`). No version marker at all — mtime-only
   staleness. **This one file today serves three different consumers**: the VLM
   describe stage (`describe.ts`, whose per-provider files —
   `describe-providers/{anthropic,gemini,openai}.ts` — hardcode `image/jpeg` as the
   media type sent upstream; `describe.ts` itself just reads the bytes and
   short-circuits on ENOENT), `GET
/api/preview/:slug/*` (Preview screen for self-hosted web/native clients),
   and `GET /api/fs/preview` (path-addressed sibling for Apple's direct-filesystem
   browse flow). All three currently assume JPEG.
3. **Web, self-hosted client** (`HttpLibrarySource.previewBlob`,
   `src/web/.../addressing/http-library-source.ts`): a thin `GET
/api/preview/...` blob passthrough — **zero independent recipe**, it just displays
   whatever the server produced. **Web, Hosted (no server)**
   (`FsAccessLibrarySource.previewBlob`): `// Hosted preview: same path as thumb for
now. Full preview generation is M3.` — **there is no display-preview generator on
   Hosted-web today at all**; it silently falls back to the 256px thumbnail. This is
   the one true greenfield gap in the recipe matrix, not a "migrate an existing bad
   implementation" situation — an earlier draft's proposal to build it as a
   canvas-resize of a full WASM develop was never merged (correctly rejected per the
   plan's finding #3).

**The shared Rust core, confirmed:**

- `raw-ffi/src/thumbnail.rs` (full file read) has one shared, parameterized core,
  `render_thumbnail_to_file`, already used by two sibling externs:
  `maple_render_thumbnail_avif_to_file` (256px, AVIF, default quality 55) and
  `maple_render_thumbnail_preview_jpeg_to_file` (1280px, JPEG, default quality 85). Both
  call the same private `extract_embedded_preview` (tries `preview_image` →
  `full_image` → `thumbnail_image` in that priority order), `resize_long_edge`
  (Triangle filter, **never upscales** — `if long_edge <= max_px { return img }`), and
  `bake_orientation` (delegates to `raw_core::image::apply_orientation`).
  `render_thumbnail_to_file` takes an `encode: fn(u32,u32,&[u8],u8) ->
Result<Vec<u8>>` function pointer, so adding a third sibling extern for the
  1280px AVIF tier is a ~15-line addition of the same shape, not new plumbing.
- `raw_core::avif::encode` (`raw-core/src/avif.rs`): `AVIF_SPEED: u8 = 6` (module
  constant, not parametrized per call site today), quality `[1,100]` on AVIF's own
  scale, **embeds no ICC profile** ("color-managed viewers assume sRGB for untagged
  AVIF, matching `jpeg::encode`'s convention").
- `raw_core::jpeg::encode` (`raw-core/src/jpeg.rs`): same "no ICC, assume sRGB"
  convention.
- **The Rust AVIF-thumbnail FFI symbol is exposed to and linked into Apple** —
  `maple_render_thumbnail_avif_to_file` is declared in
  `src/apple/Frameworks/include/RawPipeline.h` and present in the built
  `RawPipeline.xcframework`. **Apple's shipped 256px thumbnail generator
  (`ThumbnailLoader.swift`/`ThumbnailEncoder.swift`) does not call it** — despite the
  symbol being available and linked, Apple independently reimplements embedded-preview
  extraction via ImageIO (`CGImageSourceCreateThumbnailAtIndex`) and AVIF encoding via
  `CGImageDestination` (`ThumbnailEncoder.swift`). This is the single most load-bearing
  fact for §1's decision below: it is not a hypothetical option, it is the
  already-shipped precedent for the closely analogous sibling tier.
- **No RAW-embedded-preview-extraction WASM binding exists today.** Read
  `raw-wasm/src/lib.rs` in full: every exported function (`render_bytes`,
  `render_bytes_sized`, `render_bytes_scene_linear*`) is a full develop through
  `raw_core::pipeline::render_from_raw_with_quality_and_source`. The plan's claim that
  one "may already exist" is **false** — confirmed directly, not taken on faith.
  `raw-wasm` already depends on `raw-core` (not `raw-ffi`) and pulls in `rawler`
  transitively (per its own Cargo.toml comment), so the dependency graph already
  supports adding one; it doesn't exist yet.
- `raw-ffi`'s `extract_embedded_preview`/`resize_long_edge`/`bake_orientation` are
  private functions living in `raw-ffi`, which `raw-wasm` cannot link (different crate,
  C-ABI-only surface). To share them with Web, they need to move up into `raw-core`
  (§1.1).

**Second independent-implementation precedent, confirmed:** `src/api/src/indexer/id.ts`
computes `maple_id` via a hand-written TS reimplementation of the spec (`@noble/hashes`
blake3/sha1), not a WASM/FFI call into `raw_core`'s `maple_id_primary`/`maple_id_fallback`
(also linked into Apple's header, at `RawPipeline.h:1215`/`1240`) — a second confirmed
case of "independently implemented per platform against a shared spec," not "same
compiled binary everywhere."

**Explicit, repo-stated architecture policy**, `docs/spec/06-cross-platform.md`:

> Not listed: code parity. Maple deliberately writes Swift, TypeScript, and Rust in
> their idiomatic styles. Sharing _behavior_ matters; sharing _source_ only matters
> inside the Rust core.

and "Pixel parity. The same `AdjustmentModel` on the same input RAW produces visually
identical pixels (ΔE ≤ 1 target, ≤ 3 tolerance) on every platform" is listed as the #2
invariant, with "sidecar parser/serializer... must produce byte-identical output" as an
explicit example of a deliberately-reimplemented, parity-tested component.

**`PIPELINE_OUTPUT_VERSION` does not govern this tier — confirmed, not assumed.**
`docs/pipeline-output-version.md`, Adopters section: "A foreign, unmarked thumb
(server or native embedded extraction, **pipeline-independent**) is still trusted
as-is." `PIPELINE_OUTPUT_VERSION` versions the _develop pipeline's_ rendered output
(full RAW→pixels with an `AdjustmentModel` applied); embedded-preview extraction
never touches that pipeline. Reusing `PIPELINE_OUTPUT_VERSION` for this tier would be
wrong on the merits, not just architecturally inconvenient — see §2.2.

**A second, separate cache lives in the same directory — confirmed, out of scope.**
`docs/caching.md` §3 and `RenderedPreviewCache.swift` describe a _different_ Apple
cache, also under `.maple/previews/`, keyed `"{urlHash}_{sha256Prefix(variant)}.jpg"`
(screen-width-bucketed, folds in `pipeline_output_version` + `sidecar_mtime` — a
genuinely edit-aware, pipeline-dependent cache for the _editor's_ cold-open seed, not
the Preview screen). `EditSession+Hydration.swift` confirms three separate cold-open
seed paths exist: `RenderedPreviewCache` (developed, edit-aware),
`seedFromEmbeddedPreview` (live extraction, uncached), and
`seedFromMapleSidecarPreview` (reads `MapleSidecarPaths.previewURL` — **the same file
this spec governs**, "Primary instant cold-open path for a pano" per its doc comment).
This third path is a confirmed additional consumer of the tier this spec defines,
alongside the Preview screen and the pano stitcher (`maple-pano/src/stitch/io.rs::
write_display_sidecars`, which writes the `_1600.jpg` sibling today). `RenderedPreviewCache`
itself is untouched by this spec.

## 1. Pixel recipe, split by source type

### 1.1 RAW recipe: convergence decision

**Decision: independently implemented per platform, verified by parity harness — with
one concrete exception where two of the three platforms should share the literal Rust
primitive because the plumbing already makes it nearly free.**

This is not a hedge; it resolves to two different concrete architectures for two
different platform pairs, for two different reasons, both grounded in confirmed
current-state facts:

- **Web ↔ Server: share the literal compiled Rust extraction primitive.** Both already
  route through Rust (server via `raw-ffi` FFI, Web via `raw-wasm`), and Web currently
  has _zero_ extraction capability (§ Grounding). Building it independently in
  TypeScript would mean re-implementing `rawler`'s per-format embedded-preview-slot
  logic (DNG SubIFD vs. `preview_image` vs. root-IFD thumbnail, across a dozen RAW
  dialects) a second time in a different language — expensive, error-prone, and with
  no existing precedent of this codebase hand-rolling RAW container parsing outside
  Rust. **Concrete implementation shape, corrected from an earlier draft that would
  have regressed server memory efficiency (caught by review):** move
  `extract_embedded_preview`, `resize_long_edge`, and `bake_orientation` out of
  `raw-ffi/src/thumbnail.rs` (private today) into a new `raw_core::preview` module
  (public, re-exported at the crate root), generic over `R: Read + Seek` rather than
  either a filesystem path or a full in-memory `&[u8]` buffer:
  `extract_embedded_preview<R: Read + Seek>(r: &mut R, ext: &str, max_px: u32) ->
Result<PreviewRgb>`. **Why not a bare `raw: &[u8]` parameter (the earlier draft's
  proposal):** embedded-preview extraction reads a specific IFD/SubIFD offset inside
  the RAW container, not the whole file — the FFI/server path today gets that
  efficiency for free from a seek-based file read (only the bytes at the preview's
  actual offset are ever touched, not the full 20–100MB RAW). Forcing that caller
  onto a `&[u8]` parameter would require reading the entire file into memory first
  just to form the slice, solely to satisfy WASM's calling convention — a real,
  needless memory-efficiency regression on the server path for the sake of a
  browser-side caller that doesn't even need it structurally. `R: Read + Seek` avoids
  this entirely: the FFI/file caller passes an open `std::fs::File` (already
  efficient, seek-based, unchanged from today's behavior); the WASM caller wraps its
  `&[u8]` in `std::io::Cursor` (a zero-copy, in-memory `Read + Seek` adapter over the
  buffer JS already handed it) — one function body, both callers keep their natural,
  efficient representation, no forced buffering on either side.
  `raw-ffi/src/thumbnail.rs`'s existing functions become thin call-through wrappers
  passing their already-open `File` (behavior-preserving, pure move — the existing
  256px and 1280px-JPEG externs keep working unchanged). `raw-wasm` adds a new
  binding, `extract_display_preview_rgb(raw: &[u8], ext: &str, max_px: u32) ->
Result<PreviewRgb, JsError>` (same `&[u8]`/`ext` calling convention `render_bytes`'s
  WASM binding already uses — the public WASM signature is unchanged from the
  earlier draft; only the shared Rust-core function's internal generality changed),
  wrapping its `raw` slice in a `Cursor` before calling the shared
  `extract_embedded_preview`, returning oriented RGB8 + dimensions — **not**
  pre-encoded AVIF bytes (see §1.6 for why the encode step stays in JS/canvas, not
  WASM).
- **Apple: independent ImageIO implementation, matching the already-shipped sibling
  tier's decision.** Apple's 256px thumbnail generator has the Rust AVIF-extraction FFI
  symbol linked and available and _chose not to call it_, shipping an independent
  ImageIO-based implementation instead — this is not a hypothetical alternative, it's
  the actual, current, working architecture of the closest analogous tier in this
  exact codebase. Overriding that established choice for the display-preview tier
  would need its own justification; none is evident (Apple's ImageIO path already
  correctly restricts itself to embedded-preview-only, `FromImageIfAbsent: false`,
  matching the same "no full RAW decode" recipe constraint the Rust path enforces —
  the two are the same _algorithm_, independently executed). The plan's suggestion
  that "Apple's ImageIO-based extraction may not be swappable for a Rust call without
  larger rework" turns out to not even be the operative constraint — the FFI call is
  demonstrably plumbed and available; the codebase simply already decided not to use
  it for this class of tier, and this spec follows that established decision rather
  than re-litigating it.

**Governing invariant (from `docs/spec/06-cross-platform.md`, applied here):** Apple's
independent implementation must hit the repo's stated pixel-parity bar against the
Web/Server Rust-primitive output, verified by the Stage 5 harness (§4) — not verified
by inspection or "it's ImageIO so it's probably fine." This is the same bar
`develop_preview_parity.rs` already enforces for the server's _developed_ preview
tier (see §4). **The exact numeric bar itself is not fully settled — see Open
Question 5.**

### 1.2 Bitmap recipe (JPEG/PNG/TIFF/PSD/HDR/HEIC)

**Decision: match the server's existing `renderBitmapPreviewToFile` recipe exactly on
every platform** — decode with orientation applied, resize-inside without enlargement,
encode. Concretely:

- **Server** (already shipped, `src/api/src/thumbs/render.ts`): `sharp(src,
SHARP_INPUT_OPTS).rotate().resize(1280, 1280, {fit:'inside', withoutEnlargement:
true})`, then `.avif({quality, effort: THUMB_AVIF_EFFORT})` (this spec's new
  1280px-AVIF branch) instead of today's `.jpeg({quality: 82, mozjpeg: true})`.
  `THUMB_AVIF_EFFORT = 4` already exists and is already used for the 256px bitmap-AVIF
  path — reuse it unchanged (see §1.6 for why no new effort constant is introduced).
  This is close to a one-line change: `renderImageThumbToFileViaPool`'s `format`
  argument already supports `'avif'` (it's the mechanism the 256px thumb tier already
  uses for bitmaps); `previewer.ts`'s `renderBitmapPreviewToFile` just needs to pass
  `'avif'` instead of `'jpeg'` with the new size/quality constants from §1.6.
- **Apple:** structurally matches — `displayPreviewJPEG`'s non-RAW fallback path
  (`kCGImageSourceCreateThumbnailFromImageAlways: true`,
  `kCGImageSourceCreateThumbnailWithTransform: true`) decodes exactly and resizes
  with orientation baked in, matching sharp's `.rotate().resize(...,
withoutEnlargement:true)` behavior. **Correction to an earlier draft of this
  section:** the `kCGImageSourceThumbnailMaxPixelSize` value this path passes today
  is `displayPreviewLongEdge = 1_600` (`ThumbnailLoader+DisplayPreview.swift:40`),
  not 1280 — confirmed directly against the current source, not the 1280 this
  section previously (incorrectly) claimed was already in place. So this platform's
  bitmap path needs two changes, not one: the long-edge target must drop from 1600 to
  1280 (matching §1.5/§2.1's canonical 1280px decision) in addition to the encoder
  swap (JPEG → AVIF, reusing `ThumbnailEncoder`'s existing AVIF path, new quality —
  §1.6). Both are one-line constant/call-site changes in the same function, not a
  restructure, but Stage 4 must not assume the resize target is already correct.
- **Web, Hosted:** no bitmap preview generator exists today either (same gap as RAW).
  Build it on the existing canvas decode-and-resize path already used for Hosted
  thumbnail bitmaps (the one `canvasToBlob`/`encodeCanvas` already serves), at 1280px
  instead of the thumbnail's size, `fit: 'inside'`-equivalent (canvas draw at the
  scaled-down size only, never up).

No PSD/HDR-specific deviation for the display-preview tier beyond what
`psd-hdr-decode.ts`/`hdr-decode-isolated.ts` already do for the bitmap 1280px JPEG
tier today — same decode path, only the final encode step changes.

### 1.3 Orientation normalization

**Decision: bake orientation into pixels at generation time; the output file carries
no orientation metadata (upright by construction).** This is already the converged
behavior across all three current producers, via three different mechanisms, and this
spec keeps each platform's existing mechanism rather than forcing one:

- **Rust/FFI/WASM:** `bake_orientation` → `raw_core::image::apply_orientation(rgb, w,
h, orient)`, applied explicitly after decode, before encode. `render_thumbnail_to_file`'s
  doc comment is explicit about why: "the re-encode below carries no EXIF, so rotating
  here is the only chance to land an upright thumb on disk."
- **Apple/ImageIO:** `kCGImageSourceCreateThumbnailWithTransform: true` — ImageIO bakes
  the transform into the returned `CGImage` automatically; no manual step.
- **Server/sharp (bitmap path):** `.rotate()` with no arguments — sharp auto-rotates
  per EXIF and strips the orientation tag from the output.
- **Apple's local edited-preview writer** (`updateDisplayPreviewFromRender`): needs no
  separate bake step — it renders from an already-upright `CIImage` (the editor's live
  render output).

No change requested here; this section exists to pin the behavior as a requirement of
the unified recipe, not to introduce a new mechanism.

### 1.4 Color space / ICC / CICP handling

**Decision: sRGB, untagged (no embedded ICC profile, no explicit CICP override) — matches
every current producer's already-shipped convention exactly.**

- `raw_core::avif::encode` and `raw_core::jpeg::encode`'s doc comments both state this
  explicitly: "Embeds no ICC profile... color-managed viewers assume sRGB for untagged
  [AVIF/JPEG]."
- Apple's `previewJpegData` explicitly renders through `CGColorSpace(name:
CGColorSpace.sRGB)!` before encoding.
- This is the same convention the already-shipped 256px AVIF thumbnail migration
  validated in production; there is no reason for the 1280px tier to diverge.

**Open item, flagged not asserted (see Open Questions):** whether `image`-crate's
`AvifEncoder` writes any implicit CICP `colr` box by default (vs. genuinely no color
metadata at all) was not independently verified against the `image`/`rav1e` crate
internals in this session — I'm relying on the doc comment's own claim, which the
already-shipped thumbnail migration validates empirically in production, but Stage 5
should include a real-decode CICP/colorspace check (per the plan's own "AVIF output
validation must include a real decode, not just an `ftyp` magic-byte check" item) to
close this out with certainty rather than inherited confidence.

### 1.5 Scaling kernel and long-edge rule

**Decision: 1280px long edge (confirmed — matches the plan and the server's existing
`PREVIEW_LONG_EDGE_PX`), Triangle/box-equivalent resize filter, never upscale.**

- Rust: `resize_long_edge`'s existing Triangle filter (`image::imageops::FilterType::
Triangle`), existing "never upscale" guard (`if long_edge <= max_px { return img }`)
  — unchanged, reused as-is for the new 1280px AVIF externs.
- Server bitmap path: sharp's `.resize(1280, 1280, {fit: 'inside', withoutEnlargement:
true})` — same never-upscale guarantee, different implementation, already
  established.
- Apple: ImageIO's `kCGImageSourceThumbnailMaxPixelSize` does not upscale beyond the
  source's native size.

1280 was already the server's chosen VLM-preview size (`PREVIEW_LONG_EDGE_PX`, chosen
per its own comment as "the empirical sweet spot for caption quality on 24-MP source
photos"); this spec keeps that number for the unified tier rather than picking a new
one, since the unified tier now also serves that same describe/OCR consumer (§ Grounding).

### 1.6 AVIF encoder settings

**Decision: quality 68 (AVIF's own [1,100] scale), speed/effort unchanged from the
existing thumbnail-tier defaults (rav1e speed 6 for the Rust/FFI path, sharp effort 4
for the bitmap path) — flagged explicitly as a starting point for Stage 5's empirical
visual-fixture validation, not a final number.**

Reasoning:

- **Quality, why 68 and not 55 (the thumbnail default) or 85 (today's JPEG preview
  quality):** this tier is displayed at a materially larger on-screen size than a
  256px grid tile (full-viewport Preview screen), so visible compression artifacts
  matter more than they do for a thumbnail — 55 is too aggressive to carry forward
  unchanged. But `raw_core::avif::encode`'s own doc comment is explicit that "a
  JPEG-82-equivalent AVIF quality is typically much lower" than the JPEG number, so
  naively porting the JPEG tier's 82–85 to AVIF's quality scale would almost certainly
  over-encode (larger files than necessary for equivalent visual quality). 68 is
  proposed as a middle point — meaningfully above the thumbnail's 55, comfortably below
  a literal (and probably wrong) port of 82–85 — pending Stage 5's fixture-based
  ΔE/structural comparison against the actual current JPEG output at typical
  Preview-screen viewing sizes.
- **Speed/effort, why unchanged:** `raw_core::avif::encode`'s `AVIF_SPEED` is a
  hardcoded module constant (6), not parametrized per call site today; the thumbnail
  tier's own comment states the speed preset only affects encode throughput, not
  decode cost. This tier is generated once per asset at index time (same
  generation cadence as thumbnails, not per-scroll), so the same "favor encode
  throughput across the whole indexer backlog" reasoning that justified speed 6 for
  thumbnails applies here too — there is no confirmed evidence in this codebase that
  a slower preset is worth the indexing-throughput cost for this tier, so this spec
  does **not** introduce a second speed constant or change `raw_core::avif::encode`'s
  signature. The sharp bitmap path's `THUMB_AVIF_EFFORT = 4` is reused unchanged for
  the same reason. If Stage 5's fixtures show a meaningful quality win from a slower
  preset at acceptable indexing-throughput cost, that's a one-constant follow-up, not
  a blocker to this spec.
- **Concrete Rust-side shape (mirrors the two existing externs exactly):**
  ```rust
  #[no_mangle]
  pub unsafe extern "C" fn maple_render_display_preview_avif_to_file(
      raw_path: *const c_char,
      out_path: *const c_char,
      max_px: u32,   // 1280
      quality: u8,   // 0 → default 68
  ) -> i32 {
      let effective_quality = if quality == 0 { 68 } else { quality };
      render_thumbnail_to_file(raw_path, out_path, max_px, effective_quality,
                                raw_core::avif::encode, "avif")
  }
  ```
  (Corrected from an earlier draft of this snippet, which passed both `quality` and
  the literal `68` as two separate arguments to a function that only takes one
  quality parameter — a copy-paste artifact, not an intentional 7-argument call.
  Caught by automated review.)
- **Web canvas-encode quality is explicitly NOT numerically matched to the Rust-side
  quality** — this mirrors the already-accepted precedent for the 256px tier
  (`image-utils.ts`'s own comment: "Canvas quality is a 0–1 float — NOT sharp/Rust's
  0–100 int scale... no attempt is made to match them"). Propose `AVIF_PREVIEW_QUALITY
= 0.68` on the canvas 0–1 scale as Web's starting point, independently tunable, not
  required to converge numerically with the Rust-side `68`.
- **Web encode mechanism, decision:** the new WASM `extract_display_preview_rgb`
  binding (§1.1) returns raw RGB8 + dimensions, **not** pre-encoded AVIF bytes. The
  final encode step reuses the existing, already-shipped `canvasToBlob`/`encodeCanvas`/
  `canEncodeAvif` probe from `image-utils.ts` — but **for this canonical, shared tier,
  its JPEG-fallback branch must NOT be used to publish to the shared cache path**,
  which is a real correction to an earlier draft of this section, caught by review.

  **Why the thumbnail tier's fallback pattern doesn't transfer here.** For the 256px
  thumbnail tier, `canEncodeAvif` failing and falling back to a JPEG persisted under a
  `.jpg` extension (via `ThumbFormat`) is safe, because that tier is explicitly
  **not** part of this epic's cross-platform-shared-file model (per Non-goals) — each
  platform still generates and reads its own basename-keyed thumbnail independently;
  no other platform is ever required to open the exact byte-identical file a browser
  wrote. This tier is different by design: §2.1 fixes the canonical filename as
  `<maple_id>_1280.avif` (one extension, no negotiation), and §2.6 has every reader —
  Apple, the server, other browsers — serve/decode that path unconditionally as
  `image/avif`. A Hosted-Web writer that fell back to JPEG and either (a) still wrote
  it to the `.avif`-named path (wrong bytes under a lying extension — a reader would
  try to AVIF-decode JPEG bytes and fail) or (b) wrote it under a renamed `.jpg` path
  (invisible to every other platform's reader, which only ever looks for `.avif`)
  would break the "one canonical file, addressed the same way by every producer"
  contract this whole spec exists to establish — exactly the conflict raised in
  review.

  **The fix: `canEncodeAvif` gates whether Hosted-Web publishes to the canonical path
  at all, not what extension it publishes under.** If the browser's `canEncodeAvif`
  probe fails, Hosted-Web simply does not write to `.maple/previews/<maple_id>_1280.avif`
  for that browse session — behaviorally identical to any other producer failing to
  produce a valid derivative (a decode error, a corrupt RAW), which this spec already
  treats as "no file published this time, try again later, another platform may
  succeed first." The browser MAY still render an ephemeral, in-memory JPEG (or even
  just the canvas RGB8 buffer directly) for its own immediate on-screen display in
  that session — that is a local rendering decision with no cache-contract
  implications, since it never touches the shared `.maple/previews/` path. Given the
  target browser matrix (this repo builds against evergreen browsers; AVIF
  canvas-encode support is expected to be near-universal there — the thumbnail tier's
  fallback exists as a defensive minimum, not because it's commonly exercised), this
  is judged an acceptable, low-frequency gap rather than a reason to build a
  format-negotiation contract every reader on every platform would need to implement.
  If Stage 5's browser-matrix benchmark (§4 item 7) finds AVIF-encode failure is
  common enough in practice to matter, revisiting this as its own follow-up is cheap;
  building speculative negotiation machinery now, before that evidence exists, is not
  ("build for today's requirement, not a speculative tomorrow" per this repo's YAGNI
  convention).

### 1.7 Behavior when the embedded preview is smaller than 1280px

**Decision: adopt Apple's already-shipped floor — below 1024px long edge, RAW sources
skip publishing an image file; the client falls back to the thumbnail it already has.
Server and Rust/WASM producers must add this same floor (they don't have it today).
Bitmap sources are unaffected (native size is written, never upscaled — no floor
needed, since bitmaps decode exactly at any size).**

**Correction to an earlier draft of this section, caught by automated review (two
rounds): "no file written" cannot mean _no file at all_, and a negative-cache publish
must not leave a stale image lying around from an earlier, more permissive check.**
Combined with §2.4's rule that a missing marker is always treated as a cache miss,
writing literally nothing for an undersized asset would make every single preview
request for that asset re-parse the RAW and re-extract the embedded preview from
scratch, forever — an unbounded, perpetual cache-miss loop, not a one-time skip. The
fix: **the producer still writes the `.v` marker (current `PREVIEW_RECIPE_VERSION`)
even when it decides not to publish an image — and, before doing so, unlinks any
pre-existing image file at that path (best-effort, same non-fatal-on-failure pattern
as §2.7's legacy-file cleanup).** This is a legitimate, stable third state, distinct
from both a normal cache-hit and a real cache-miss:

- **Marker present + current, image present** → normal cache hit, serve the image.
- **Marker present + current, image absent** → _negative-cache hit_: this asset's
  embedded preview was checked at the current recipe version and found under the
  1024px floor. Nothing to serve; the client falls back to the thumbnail. Do **not**
  regenerate — the check has already run at the current recipe.
- **Marker missing, unreadable, or older than current** → real cache miss per §2.4;
  regenerate (which may again conclude "undersized" and re-publish only the marker).

**Why the unlink step is required, not optional:** the second state above (negative-
cache hit) is only a sound, stable state if "image absent" genuinely holds. Without
the unlink step, an asset that had a real image published at an older recipe version
(e.g. an earlier `PREVIEW_RECIPE_VERSION` had a smaller floor, or the embedded-preview
extraction logic changed what it considers "present") and is now re-checked at a newer
recipe that concludes "undersized" would be left with a **stale image sitting next to
a fresh marker** — a reader would see "marker current + image present" and (wrongly)
treat that as a normal cache hit, serving indefinitely stale pixels. Publishing order
for the negative-cache case is therefore: unlink any existing image at the path, THEN
write the marker — mirroring image-then-marker's own torn-read reasoning in the
opposite direction (here, marker-after-unlink guarantees a reader never observes
"current marker + present image" unless a real image write actually happened).

This composes cleanly with §2.3's atomic publish order rather than undermining it: the
negative-cache case never _writes_ an image, so there is no new image write for the
marker-write to race ahead of — the added unlink step only ever removes a prior
producer's stale artifact, it does not introduce a second concurrent image writer.

Reasoning:

- Apple's `minUsefulEmbeddedLongEdge = 1024` already encodes the correct principle:
  "EXIF thumbs are ~160px — worse than the grid thumbnail already on screen — while
  real embedded previews are ≥1024 on every modern body." Swapping in a preview that's
  _smaller_ than what's already displayed is a visible regression, not an improvement —
  this reasoning is sound and this spec promotes it from an Apple-only constant to the
  shared canonical recipe rule (same numeric floor, 1024px).
- **This is a real, stated behavior change for the server/Rust path**, which today
  does _not_ have this floor: `resize_long_edge` happily returns a smaller-than-target
  image unchanged if the embedded preview is already under 1280px, and
  `previewer.ts`'s own doc comment says this is "acceptable for the VLM, which
  gracefully handles smaller inputs." Adopting the floor for RAW sources means some
  assets that get a (small) preview file today will get none after this migration.
  This is judged safe because `describe.ts`'s consumer path already has a defined,
  graceful "no preview" behavior: `previewer.ts`'s own comment confirms "the describe
  stage will see no preview on disk and short-circuit cleanly via its ENOENT path" —
  so the floor doesn't newly break the VLM consumer, it just makes that already-handled
  path somewhat more common for cameras whose embedded previews are unusually small.
  This tradeoff (fewer captions for a presumably rare camera population, in exchange
  for a canonical tier that never regresses visible resolution below the grid
  thumbnail on any platform) is judged worth it and is stated explicitly here rather
  than left implicit.
- No upscaling under any circumstance, on any platform, for any source type — already
  universal across all three current implementations (`resize_long_edge`'s early
  return, sharp's `withoutEnlargement: true`, ImageIO's native behavior).

## 2. Version contract

### 2.1 Canonical filename

**Confirmed matches the plan's stated direction — adopted as-is:**

```
<library_root>/<fileinfo[0].path>/.maple/previews/<maple_id>_1280.avif   (image)
<library_root>/<fileinfo[0].path>/.maple/previews/<maple_id>_1280.v     (marker)
```

This requires Apple's `MapleSidecarPaths.previewURL`/`previewVersionURL` to switch
their key input from `sha256prefix16(assetURL.lastPathComponent)` to `maple_id` — a
**hard dependency on Stage 3** landing a Swift `maple_id` implementation first; Stage 4
cannot start the Apple side of this migration before that lands. This dependency isn't
explicit in the plan's own Stage 2 bullet, but it's a direct, confirmed consequence of
reading `MapleSidecarPaths.swift`: the file literally does not have access to
`maple_id` today.

`cachePathForAsset`'s `previews` branch (`fs/xmp.ts`) hardcodes the `.jpg` extension
today (`${asset.maple_id}_${s}.jpg`) — implementing this filename requires that
function to become extension-aware for the canonical tier specifically, while leaving
the still-JPEG `_dev_<sidecar_ver>` developed-preview tier unaffected. This spec does
not redesign that function's signature (Stage 4's job, per Non-goals), but states the
concrete requirement it must satisfy: given `(maple_id, 'previews', '1280', 'avif')`,
resolve to the path above.

### 2.2 Where the shared version number lives

**Decision: a new, separate codegen-generated constant, `PREVIEW_RECIPE_VERSION`, NOT
a reuse of `PIPELINE_OUTPUT_VERSION`.**

This is a substantive correction to a plausible-sounding but wrong alternative: reusing
`PIPELINE_OUTPUT_VERSION` would be actively incorrect, not just a stylistic choice, per
the confirmed grounding above — `PIPELINE_OUTPUT_VERSION` versions the _develop
pipeline's_ rendered output (a function of `AdjustmentModel` + demosaic/AgX math), and
`docs/pipeline-output-version.md` explicitly states embedded-preview extraction is
"pipeline-independent" and untouched by it. This tier's recipe changes (extraction
priority order, resize kernel, orientation-bake mechanism, AVIF quality/speed) are
orthogonal to develop-pipeline changes in both directions: a `PIPELINE_OUTPUT_VERSION`
bump (e.g., a new AgX LUT) must NOT invalidate this tier (it was never rendered through
that pipeline), and a `PREVIEW_RECIPE_VERSION` bump (e.g., raising AVIF quality from 68
to 72) must NOT invalidate `RenderedPreviewCache` or the Hosted thumb cache (they don't
consume this recipe). Conflating the two constants would cause both false invalidations
(wasted regeneration) and false negatives (stale artifacts silently served) — this is
exactly the class of "silent reinterpretation" bug `PIPELINE_OUTPUT_VERSION`'s own doc
was written to prevent, and reusing it here would reintroduce a version of that same
problem at the wrong axis.

**Concrete mechanism, following the `PIPELINE_OUTPUT_VERSION` precedent's actual
plumbing exactly:**

- New module `src/raw-pipeline/raw-core/src/preview_recipe_version.rs`, structured
  identically to `version.rs` (module doc explaining the bump policy: extraction
  priority order, resize/orientation logic, or AVIF encoder settings — bump by
  exactly one in the same commit as the recipe-changing edit; a change that doesn't
  alter output pixels, e.g. an internal refactor, does not bump it):
  ```rust
  pub const PREVIEW_RECIPE_VERSION: u32 = 1;
  ```
  Re-exported at the crate root: `pub use preview_recipe_version::PREVIEW_RECIPE_VERSION;`
  in `raw-core/src/lib.rs`, alongside the existing `pub use version::PIPELINE_OUTPUT_VERSION;`.
- `codegen/src/main.rs`: `use raw_core::PREVIEW_RECIPE_VERSION;` alongside the existing
  `PIPELINE_OUTPUT_VERSION` import. Append a **third** `// MARK: -`-delimited block to
  both `emit_swift` and `emit_ts` (right after the existing "Pipeline-output version"
  block, same functions, same generated files — no new `Schema` enum variant, no new
  codegen invocation, no `tools/codegen.sh` change needed): Swift emits
  `AdjustmentModel.previewRecipeVersion: UInt32`, TS emits `export const
PREVIEW_RECIPE_VERSION = N`. This lands in the exact same two generated files
  (`AdjustmentModel+Generated.swift`, `adjustment-model.generated.ts`) as
  `pipelineOutputVersion`/`PIPELINE_OUTPUT_VERSION` already do — I'm deliberately
  following the established (if slightly odd — this file is nominally about the
  adjustment-model schema) precedent of piggybacking an unrelated single constant onto
  the existing generated file, rather than introducing a new schema/file for one
  integer. The alternative (a dedicated `Schema::PreviewRecipe` variant emitting its
  own generated file) is viable and slightly more "correct" architecturally, but this
  spec picks the smaller-diff option that exactly matches how `PIPELINE_OUTPUT_VERSION`
  itself was introduced, on the theory that consistency with the one existing precedent
  outweighs marginal naming cleanliness.
- Each of the three producers folds `PREVIEW_RECIPE_VERSION` into the `.v` marker
  content exactly as Apple's `#1976` marker already does for its local
  `displayPreviewTierVersion` (a single integer, written as plain text — no JSON, no
  additional fields), sourced from the codegen'd constant rather than each platform's
  own hand-maintained integer (which is precisely the `THUMB_PIPELINE_VERSION =
PIPELINE_OUTPUT_VERSION` pattern in `maple-cache.service.ts`, applied to the new
  constant instead).

### 2.3 Atomic publish order

**Decision: write the image file first (atomic, .tmp + rename), then write the `.v`
marker last (also atomic, .tmp + rename or platform-equivalent single-file atomic
write) — image-then-marker, never the reverse.**

This is not a new invention — it's what both existing precedents already do, confirmed
directly: Apple's `produceDisplayPreview`/`updateDisplayPreviewFromRender` write
`data.write(to: previewURL, options: .atomic)` **then** call
`writeDisplayPreviewMarker`; Web's `writeThumb` writes the blob **then** the `.v`
companion. This spec makes explicit _why_ this order and not the reverse, per the
torn-read requirement the plan calls out:

- A reader gates on the marker (`displayPreviewMarkerIsCurrent`-equivalent) before
  trusting the image bytes. If the marker were written **first**, a reader could
  observe "marker says current" paired with an image file that is either mid-write
  (a partially-renamed `.tmp`, though POSIX same-volume `rename()` is atomic so this
  specific case shouldn't be observable) or, more realistically, **still the old
  image from a previous recipe version** — because between the marker write and the
  image write there's a window where the marker already claims the new version but
  the bytes on disk are still the old ones. That's exactly the failure mode the task
  requires never happen.
- Writing image-then-marker means: if a reader observes a **current** marker, the
  image write that marker corresponds to is guaranteed to have already completed
  (program order + each individual write's own atomicity). If a reader observes a
  **missing or stale** marker next to a freshly-written image (the gap between the two
  writes, or a writer that crashed between them), that's the safe failure direction —
  the reader treats it as a miss and either regenerates (worst case: one redundant
  render, the same class of acceptable cost the plan already accepts for "a spurious
  bump costs one cache miss per asset") or, for concurrent-writer races, coalesces
  with an in-flight write via the existing per-platform in-flight/dedup mechanisms
  (Apple's `inFlight` task map; the server's per-request handling).
- **Concurrent-writer race (Apple and server racing to publish the same file, plan's
  Stage-4 test item):** same-volume `rename()` is POSIX-atomic, so the last writer's
  `rename()` wins cleanly for the image file, and independently for the marker file —
  no torn bytes are ever observable by a third reader, only "which version won" is
  racy. **Correction to an earlier draft, caught by automated review: "both writers
  are producing the same recipe" is not a safe assumption during a staggered
  rollout.** Two clients on different app versions (e.g. Apple not yet updated to a
  new `PREVIEW_RECIPE_VERSION`, the server already updated) can genuinely race with
  _different_ compiled-in recipe versions. Without a guard, this produces a torn state
  the original reasoning didn't cover: an older-recipe writer's image `rename()`
  landing _after_ a newer-recipe writer already published both its image and marker
  would silently downgrade the image bytes while leaving the newer marker in place —
  a reader would see "marker=newer, image=older," the same class of failure §2.3's
  ordering exists to prevent, just reached by a race between two _different-recipe_
  writers instead of a single writer's own two-step publish.

  **The fix: every producer re-reads the current on-disk marker immediately before
  publishing (i.e. before its own image write, not just before its marker write) and
  skips the _entire_ publish — image and marker both — if the on-disk marker's
  version is already ≥ its own compiled-in `PREVIEW_RECIPE_VERSION`.** This is the
  direct generalization of §2.5's forward-compatibility rule ("an old client must
  never overwrite a newer marker") applied consistently to the image write as well as
  the marker write, rather than only to the marker. With this check in place: the only
  way an image write proceeds is when the writer's own recipe is strictly newer than
  (or the marker is missing/stale relative to) whatever is currently published, so a
  strictly-older writer can never clobber a strictly-newer one's image, regardless of
  which `rename()` physically lands last — the race is resolved by the pre-check, not
  by hoping `rename()` ordering happens to favor the newer writer. Two writers on the
  _same_ recipe version can still race harmlessly (as originally reasoned: same
  recipe, visually equivalent output, "which one wins" doesn't matter) — this
  additional check only changes the outcome for the _different_-recipe-version case
  the earlier draft missed.

  **Flagged as an open question, not asserted with full confidence:** this reasoning
  assumes the shared library folder is a genuinely POSIX-rename-atomic filesystem; if
  it's mounted over SMB/NAS (the concrete deployment target this whole plan exists
  for), cross-network rename atomicity is a weaker, protocol- and server-dependent
  guarantee than local POSIX semantics. This spec does not independently verify SMB
  rename atomicity in this session — Stage 4's concurrent-writer tests should target
  the actual NAS deployment path, not just a local filesystem, to close this out with
  confidence rather than inherited assumption.

### 2.4 Reader behavior

**Decision: missing, unreadable, or older-than-current marker → treat as a miss,
regenerate.** This differs in one important, deliberate way from the existing
_thumbnail_ tier's marker semantics, and that difference is explained, not glossed
over:

- Apple's `displayPreviewMarkerIsCurrent` already implements exactly this
  ("missing/unreadable/older markers read as stale") for the existing 1600px tier —
  this spec keeps that behavior, generalized to `PREVIEW_RECIPE_VERSION`.
- **This is the opposite of the 256px thumbnail tier's marker semantics** —
  `MapleCacheService.readThumb` in `maple-cache.service.ts` treats a **missing**
  marker as "foreign, trusted as-is" (a thumb written by the server or native
  embedded extraction, which the thumb tier's own doc comment calls
  "pipeline-version-independent"), and only an **older-than-current** marker is
  treated as stale. That asymmetry exists for a specific, load-bearing reason: for
  thumbnails, only the Hosted-web _locally-developed_ path writes a marker at all
  (because only that path is pipeline-dependent); server- and native-produced thumbs
  are genuinely pipeline-independent and correctly need no marker. **For this new
  unified tier, that asymmetry does not apply**, because `PREVIEW_RECIPE_VERSION`
  governs embedded-preview extraction itself (resize kernel, orientation-bake
  mechanism, AVIF settings) — every producer's output is versioned by it, including
  Apple's and the server's, which were the "trusted foreign, no marker needed" case
  for the thumbnail tier. So for this tier, **every producer is required to write the
  marker**, and a missing marker unambiguously means "written before this contract
  existed, or by something that doesn't implement it" — always a miss, never a
  trusted foreign artifact. Getting this distinction right matters: copying the thumb
  tier's "missing marker = trust it" semantics onto this tier would silently serve
  pre-migration JPEG files (or worse, files whose recipe changed for a reason the
  reader has no way to know about) forever.
- Source mtime remains a secondary, cheap pre-filter exactly as it is today in
  `freshDisplayPreviewData` (preview mtime ≥ asset mtime) — this doesn't change, it
  just runs _in addition to_, and gated behind, the marker check, matching the
  existing Apple implementation's actual order of operations (marker check first,
  then mtime).

### 2.5 Forward compatibility: older client, newer marker

**Decision: monotonic version numbers mean "requires regeneration if mine is lower."
A client encountering a marker with a HIGHER version than its own compiled-in
`PREVIEW_RECIPE_VERSION` treats the file as valid/current and does NOT attempt to
regenerate or overwrite it.**

Reasoning: the alternative (an old client treats an unrecognized-future version as
untrustworthy and overwrites it with its own, older-recipe output) is strictly worse —
it would let an old client stomp a newer, better-recipe file with a worse one every
time it runs, which is exactly backwards from what a monotonic version scheme is for,
and would make the "whichever platform generates it first" cross-platform sharing
model actively hostile to staggered rollouts (an un-upgraded Apple build could churn a
freshly-upgraded server's AVIF file back down to worse quality on every browse). Since
a version bump by construction only ever means "the recipe changed," an old client has
no way to produce output that's _better_ than what a newer marker already represents,
so the only sound default is: newer-than-mine is still trustworthy, don't touch it.
This is the direct generalization of the plan's own framing ("a spurious [regeneration]
costs one cache miss per asset; a missed bump serves stale pixels indefinitely") to the
forward-compatibility direction — an old client blindly regenerating over a newer file
would be the forward-compat equivalent of "serving stale pixels indefinitely," just in
the other direction (destroying fresher pixels instead of serving staler ones).

### 2.6 Downstream Content-Type contract (flagged for Stage 4, stated here for completeness)

Once the canonical tier is AVIF, `library/preview.ts` and `fs-previews.ts` must switch
their unconditional `Content-Type: image/jpeg` response header to `image/avif` for the
canonical (unedited) branch — but **not** for the `developedPreviewResponse` branch
(`_dev_<sidecar_ver>`, still JPEG, out of scope per Non-goals). `describe.ts` must
decode the now-AVIF file and re-encode to JPEG in memory before each VLM provider call
(every provider hardcodes `image/jpeg`, confirmed in `previewer.ts`'s and
`raw-ffi/src/thumbnail.rs`'s doc comments) — this is Stage 4 implementation work per
the plan, restated here only so the version contract above is read with the correct
downstream consequence in mind.

### 2.7 Legacy JPEG cleanup (Stage 4 requirement, flagged by automated review)

**Decision: each producer, when it publishes a new `<maple_id>_1280.avif`, must also
unlink a co-located legacy `<maple_id>_1280.jpg` at the same stem if one exists.**

This is a real gap an earlier draft of this spec did not address: `cache-gc.ts`'s
sweep (§3.1 below quotes its current regex) is presence-of-_asset_-based, not
format-aware — it keeps _any_ file whose `<maple_id>` stem matches a live asset,
regardless of extension. Once the canonical tier moves to `.avif`, the old
`<maple_id>_1280.jpg` written by every producer's pre-migration code is a file whose
`maple_id` still belongs to a live, existing asset — `known.has(mapleId)` is `true` —
so `cache-gc.ts` will keep it **forever**. Across every asset in every library, this is
an unbounded storage leak (roughly double the previews-tier disk usage, indefinitely),
not a transient migration artifact that self-cleans.

Extending `cache-gc.ts` with format-aware pruning (e.g. "if both `<stem>.jpg` and
`<stem>.avif` exist for the same stem, delete the `.jpg`") is one fix, but it adds a
second cross-file-comparison pass to a sweep that is currently a simple single-file
classification, and it only reaches assets that get swept (library-root-registered,
on a boot-triggered cadence). The simpler, more immediate fix — and the one this spec
requires of Stage 4 — is **writer-side cleanup at generation time**: whichever
producer (Apple, server, Web) is about to atomically publish `<maple_id>_1280.avif`
per §2.3's image-then-marker order also checks for a same-stem `<maple_id>_1280.jpg`
immediately after the image write succeeds, and deletes it if present (best-effort —
a failed delete is not fatal to publishing the new file, just logged). This
guarantees the leak self-heals as each asset's preview naturally gets regenerated
post-migration (every asset that anyone actually browses converges to a single file
within one regeneration), without adding new sweep logic to `cache-gc.ts`, and without
depending on every library being swept promptly. `cache-gc.ts` itself needs no change
for this — Stage 1's fix already stays correct (an asset that's genuinely deleted
still gets both its `.jpg` and `.avif` cleaned up the existing way, since the sweep
matches on `mapleId` independent of extension).

**Gap in the above, caught by a second round of automated review: this only covers
the server's same-stem `.jpg`→`.avif` migration. Apple's pre-migration legacy file is
a completely different case and needs its own explicit cleanup step.** Per the
Grounding section, Apple's _current_ (pre-this-spec) display-preview file lives at
`<sha256prefix16(basename)>_1600.jpg` — a different key scheme entirely (basename hash,
not `maple_id`; `_1600` size suffix, not `_1280`), not merely a same-stem
format-extension difference. The writer-side cleanup above — "check for a same-stem
`.jpg` next to the `.avif` you just wrote" — structurally cannot find this file, because
it isn't at the same stem; it's at an unrelated filename computed by a different
formula. Left unaddressed, every Apple-origin legacy preview would be orphaned
permanently: `cache-gc.ts`'s existing "unknown shape, unlink" branch (its 16-hex-char
legacy-thumb case, §1's doc comment) _would_ catch these on a server-registered
library's next sweep — but for the case this whole epic is centrally motivated by
(Apple browsing a local folder or an SMB share directly, no self-hosted server
involved at all), there is no sweep of any kind, and no other mechanism ever visits
that file again.

**Fix: Apple performs this cleanup itself, at the point it first publishes the new
canonical `<maple_id>_1280.avif` for an asset.** Apple already computes the legacy
path today (`MapleSidecarPaths.previewURL` _is_ that computation — `sha256prefix16` of
the same basename it always had) and is the only platform positioned to know both the
old key and the new key for the same asset in the same code path; the server and Web
have no way to derive `sha256prefix16(basename)` for an asset they're indexing purely
by `maple_id` (they were never guaranteed to see the original basename this legacy
scheme was keyed on when browsed independently). So this is Apple-specific cleanup,
not a generalized cross-platform rule: when Apple's canonical-tier writer (§1.1)
succeeds in publishing `<maple_id>_1280.avif` for an asset it has not previously
migrated, it computes the legacy `MapleSidecarPaths.previewURL`-style path for that
same asset and unlinks it if present (best-effort, non-fatal on failure, same pattern
as the rest of this section) — along with the legacy `<key>_1600.v` marker file
(#1976) at the same legacy stem, so no half-migrated legacy artifact pair is left
behind either.

## 3. Apple's edited-preview local-only contract

### 3.1 Filename

**Decision: `<maple_id>_1280_local_edit.avif`, sibling marker `<maple_id>_1280_local_edit.v`.**

Verified directly against the actual, currently-shipped `MAPLE_ID_RE` in
`src/api/src/workers/cache-gc.ts` (Stage 1's just-shipped fix, commit `99cfc4d23`):

```js
const MAPLE_ID_RE = /^[0-9a-f]{32}(?:_[a-z0-9_]+)?$/;
```

`<maple_id>_1280_local_edit` matches cleanly: 32 hex chars, then `_1280_local_edit`,
which is `[a-z0-9_]+` (digits, lowercase letters, underscores only) — the regex's own
comment confirms this exact suffix shape was the motivating case for the Stage 1 fix
("the display-preview stage's `<maple_id>_dev_<sidecar_ver>` developed-preview
filenames are recognized as known-shape"). `cache-gc.ts` extracts `mapleId =
stem.slice(0, 32)` regardless of suffix content, so once matched, the file survives
GC as long as `known.has(mapleId)` — i.e., as long as the asset itself still exists,
independent of which suffix variant it is. This is the correct behavior: the file gets
cleaned up automatically when the asset is hard-deleted (§3.4), without needing any
suffix-specific GC logic.

Distinct from the canonical `<maple_id>_1280.avif` by construction (different stem),
so no collision risk with the shared file, and distinct from the server's own
`<maple_id>_dev_<sidecar_ver>.jpg` (different extension and shape) — the three preview
variants that can coexist under `.maple/previews/` for one asset are visually
unambiguous by filename alone.

### 3.2 Freshness mechanism

**Decision: it needs both — its own `.v`-style marker (for `PREVIEW_RECIPE_VERSION`
recipe invalidation) AND continues to lean on the existing sidecar-mtime-based
freshness check (for "is this the current edit's render") — these are not
alternatives, they're the same two orthogonal axes §2.4 already established for the
canonical tier, applied here too.**

- **Recipe-version axis:** if the AVIF encode settings change (§1.6) or the resize/
  orientation logic changes, a stale local-edit render is just as invalid as a stale
  canonical render — there's no reason this file should be exempt from
  `PREVIEW_RECIPE_VERSION` gating just because it's local-only. Write
  `<maple_id>_1280_local_edit.v` the same way `writeDisplayPreviewMarker` already
  works today, just pointed at the new path and constant.
- **Edit-freshness axis:** reuse the existing mechanism nearly as-is —
  `freshDisplayPreviewData`'s pattern (previewMtime ≥ assetMtime;
  `supersededByEdit`/`sidecarAutosaveSlack` logic) already exists and is the right
  shape for "is this file still the correct render of the current sidecar state,"
  just re-targeted at comparing the local-edit file's mtime against the **sidecar's**
  mtime (not the asset's — the local-edit file's whole reason to exist is that it
  reflects the sidecar's adjustments, so sidecar mtime is the correct freshness
  anchor, mirroring what `RenderedPreviewCache`'s `sidecar_mtime` key component
  already does for the analogous edited-preview case in that separate cache). No new
  mechanism needs inventing here — this is a re-application of two already-proven
  patterns from the same file, not new design.

### 3.3 Read precedence at display time

**Decision: check the local-edit variant first (if its marker is current AND it's
fresh against the current sidecar), fall back to the canonical shared unedited file
otherwise — implemented as a new branch in `produceDisplayPreview`, not a new
dispatcher.**

Concretely, `produceDisplayPreview` (`ThumbnailLoader+DisplayPreview.swift`) currently
has this shape: check cached canonical file (fresh?) → return it; else if
`sidecarHasVisualEdits` → return nil (suppress); else generate from embedded preview,
persist to canonical, return. This spec's change to that function's control flow:

1. If `sidecarHasVisualEdits(assetURL:)` is true: check the **local-edit** file first
   (own marker current, own sidecar-mtime freshness per §3.2). If fresh, return it.
   If not fresh (edits changed since the render, or no local-edit file exists yet),
   **do not** fall through to generating a fresh embedded-preview render here — that
   would be regenerating the _wrong_ (unedited) tier for a photo that's known to be
   edited, the exact bug class this whole contract exists to prevent. Instead, keep
   today's existing suppression behavior (return nil; the thumbnail — already
   correctly showing edited pixels via `updateThumbnailFromRender` — stays on screen
   until the editor's render-publish path calls
   `updateDisplayPreviewFromRender`/`updateDerivedImagesFromRender` and writes a fresh
   local-edit file).
2. Else (no visual edits): check the canonical shared file exactly as today, generate
   from embedded preview if missing/stale, persist to the **canonical** path only —
   never to the local-edit path, since there's nothing edited to reflect.

This keeps the function's existing shape and existing callers (`loadDisplayPreview`,
the coalescing/decode-slot machinery around it) unchanged; it's an insertion of one new
branch guarded by the same `sidecarHasVisualEdits` check the function already computes,
not a rewrite.

`updateDisplayPreviewFromRender` itself (the render-publish writer, called from
`EditSession+Render` / the GPU-exit readback) changes its target path from
`MapleSidecarPaths.previewURL` (the canonical shared file — the collision bug this
whole contract exists to fix) to a new `MapleSidecarPaths.localEditPreviewURL` (§3.1's
filename), and calls the local-edit marker writer instead of
`writeDisplayPreviewMarker` for the canonical tier.

`EditSession+Hydration.swift`'s `seedFromMapleSidecarPreview` (the pano/editor
cold-open path, confirmed in § Grounding to be a real, separate consumer of
`MapleSidecarPaths.previewURL`) needs the same read-precedence branch applied at its
call site — it currently reads the canonical path unconditionally; Stage 4 must audit
this call site alongside `produceDisplayPreview`, not just the Preview screen's path,
or an edited pano would seed the editor's cold-open with stale unedited pixels.

### 3.4 Cleanup on revert

**Decision: no explicit delete on revert — the local-edit file naturally stops being
read once `sidecarHasVisualEdits` returns false (§3.3's branch 2 applies instead), and
it is reclaimed later by the existing GC sweep once the asset itself is deleted or the
file ages past whatever staleness the recipe-version/mtime checks impose. No new
cleanup code path is introduced.**

Reasoning: `cache-gc.ts`'s sweep is presence-of-asset-based (`known.has(mapleId)`), not
suffix-aware or edit-state-aware — it has no way to know "this asset's edits were
reverted, so this specific derivative is now orphaned" without new bookkeeping this
spec judges unnecessary to add. The cost of leaving a stale local-edit file on disk
after a revert is bounded and small: it's never read again (branch 2 of §3.3 always
wins once `sidecarHasVisualEdits` is false, regardless of what's on disk at the
local-edit path), and it occupies at most one file's worth of disk space per
previously-edited asset until either (a) the user re-edits the same photo (the file
gets overwritten by the next `updateDisplayPreviewFromRender` call, same path, atomic
write) or (b) the asset is eventually hard-deleted (GC reclaims it via the existing
`known`-set sweep, same as any other orphan). Explicitly deleting it eagerly on revert
would require detecting "revert" as a distinct event (today the codebase detects
"has visual edits" as a boolean predicate over sidecar content, not an edit-history
transition), which is more mechanism than the bounded, self-limiting cost of leaving
it justifies. If disk usage from this ever proves material in practice, a
follow-up can add best-effort deletion inside the same code path that already detects
`sidecarHasVisualEdits` flipping to `false`, but this spec does not require it as part
of Stage 4.

## 4. Validation criteria for Stage 5

Stage 5 must design and run a harness that gates merge on all of the following,
reusing `src/scripts/compare_images.py` (CIEDE2000 + per-channel bias, confirmed
capabilities: `mean_deltaE`, `p95_deltaE`, `max_deltaE`, optional `--zones`/`--hue-bins`
breakdowns — confirmed it does **not** currently compute any structural/SSIM metric,
so that piece is new work, not a reuse) per the plan's explicit requirement that this
class of change cannot be merged on "tune visually" evidence alone:

1. **Mean/p95/max ΔE (CIEDE2000) between each platform's canonical-tier output and a
   reference.** Two comparisons are needed, not one: (a) Apple's ImageIO-based
   extraction vs. the shared Web/Server Rust-primitive output, for the same RAW
   fixtures, at the repo's stated pixel-parity bar per `docs/spec/06-cross-platform.md`
   — that document is internally inconsistent about the exact number (its invariants
   list states "ΔE ≤ 1 target, ≤ 3 tolerance," but its own harness section states the
   currently-enforced number is "≤5"), so Stage 5 must resolve which figure actually
   gates this tier rather than inheriting the ambiguity (see Open Question 5) — this
   is the parity check §1.1's "independent implementation" decision explicitly
   requires; and (b) each producer's
   AVIF output vs. that same producer's pre-migration JPEG output (or an uncompressed
   reference render), to characterize what the format change itself costs, isolated
   from cross-platform variance. The closest existing precedent for what magnitude of
   ΔE a lossy-codec-only difference produces at this resolution is
   `develop_preview_parity.rs`'s measured JPEG-q82-only delta (mean ≈0.7–0.9, p95
   ≈2.2–2.4, max ≈13–17 on its fixture) — a reasonable starting reference point for
   what an AVIF-q68-only delta budget should look like, not a number to copy
   verbatim (AVIF at a different quality setting on a different codec has no reason
   to land at the identical numbers; Stage 5 must measure it directly).
2. **A structural/detail-preservation metric, additive to ΔE — does not exist in this
   codebase today and must be added.** Confirmed by direct grep: no SSIM or equivalent
   structural-similarity computation exists anywhere under `src/scripts/`. The plan is
   explicit that CIEDE2000 alone is insufficient at 1280px AVIF since color-difference
   metrics don't fully characterize block/ringing/blur artifacts a lossy codec change
   can introduce even at a low mean ΔE. Stage 5 must pick and integrate one (SSIM/MS-SSIM
   against the pre-migration JPEG baseline is the natural default given the existing
   Python/numpy/PIL toolchain `compare_images.py` already depends on) — left as Stage
   5's implementation choice per this task's instruction not to design the harness
   here, but the requirement itself is not optional.
3. **File-size distribution** across a representative fixture set (the existing
   `test-fixtures/references/manifest.json` cases, or an equivalent RAW/bitmap mix),
   compared against the pre-migration JPEG sizes at the same 1280px target — both a
   sanity check (AVIF should be meaningfully smaller at equivalent-or-better quality,
   or the migration isn't earning its complexity) and a regression guard (a
   misconfigured quality/speed setting producing unexpectedly large files should fail
   the gate, not ship silently).
4. **Real-decode AVIF output validation, not magic-byte-only** — per the plan's
   explicit requirement, every producer's AVIF output must be decoded (not just
   `ftyp`-sniffed) and checked for correct dimensions, correct orientation (a
   portrait source must decode upright), and the color-space assumption from §1.4
   (closes the open item flagged there about CICP/colr-box behavior with empirical
   evidence rather than an inherited doc-comment claim).
5. **Bidirectional cross-platform reuse, checked via the real marker mechanism, not
   bare mtime** — per the plan's stage-5 description: index a folder via the server,
   confirm Apple (browsing the same files directly) finds and reuses the exact
   `<maple_id>_1280.avif` file with zero new write (verified by observing no new
   `.tmp`/rename activity and an unchanged file mtime, not just "no crash"); reverse
   the order (Apple writes first, server reuses).
6. **Concurrent-writer test** — Apple and the server racing to publish the same
   derivative for the same asset must never leave a reader observing a torn image or
   a marker/image pair from two different writes (§2.3); Stage 5 should run this
   specifically against the actual NAS/SMB deployment path per the open flag in §2.3,
   not only a local filesystem.
7. **Web AVIF canvas-encode support/latency benchmark across the supported browser
   matrix**, per the plan's explicit item — confirms the existing `canEncodeAvif`/
   `canvasToBlob` fallback-to-JPEG path (§1.6) actually engages correctly on any
   browser in the support matrix that can't produce AVIF fast enough at 1280px, using
   the already-shipped 256px-tier mechanism as the proof this pattern works, extended
   to this tier's larger images and different quality setting.
8. **VLM caption spot-check against the pre-migration baseline** — per the plan's
   explicit item, not just "the describe call didn't throw": confirm the
   AVIF-decode-then-JPEG-re-encode-in-memory step (§2.6) that `describe.ts` gains in
   Stage 4 actually delivers real JPEG bytes with an `image/jpeg` declaration to the
   provider, and that captions on a fixed fixture set don't regress versus the current
   JPEG-preview baseline.

## Open Questions

Stated explicitly per this task's instruction not to invent plausible-sounding but
unverified answers:

1. **CICP/`colr`-box behavior of `image`-crate's `AvifEncoder`** (§1.4) — relying on
   `raw_core::avif::encode`'s own doc-comment claim ("embeds no ICC profile... assume
   sRGB for untagged AVIF"), which the already-shipped 256px thumbnail migration
   validates empirically in production, but not independently re-verified against the
   `image`/`rav1e` crate source in this session. Stage 5's real-decode validation
   (§4.4) should close this with direct evidence.
2. **SMB/NAS rename-atomicity guarantee for the atomic publish order** (§2.3) — the
   torn-read-avoidance reasoning assumes POSIX-local same-volume `rename()` semantics;
   this plan's actual deployment target (a shared NAS folder reachable by Apple, the
   server, and potentially Web) may not give the same atomicity guarantee over
   SMB/AMSMB2 depending on the NAS's SMB server implementation. Not independently
   verified in this session — flagged for Stage 4/5 to test against the real
   deployment path rather than assumed safe by analogy to local-filesystem behavior.
3. **Exact magnitude of AVIF-q68-only ΔE/structural delta at 1280px** — §1.6's quality
   68 and §4.1's budget reasoning are both explicitly starting points reasoned from
   adjacent (but not identical) existing measurements (the 256px AVIF thumbnail
   migration's production validation, and the JPEG-q82 develop-preview parity gate's
   measured numbers) — neither is a direct measurement of this tier's actual AVIF
   output, which does not exist yet. This is Stage 5's job to measure, not something
   this spec can responsibly assert with more precision than "a reasoned starting
   point."
4. **Whether the local-edit Apple file (§3) should itself move to AVIF now, or stay
   JPEG.** This spec recommends AVIF (`<maple_id>_1280_local_edit.avif`) for
   consistency with the canonical tier and to let the reader use one decode path for
   both variants, but the plan's Stage 4 title ("Implement only the immutable
   unedited AVIF tier") could be read as scoping the format change to the canonical
   tier only, leaving the local-edit variant JPEG for this phase. Both are internally
   consistent; this spec picks AVIF but flags that a reviewer preferring tighter
   scope-safety could reasonably choose to keep the local-edit variant JPEG in Stage 4
   and migrate it to AVIF in a smaller follow-up — either choice is compatible with
   the filename/marker contract in §3.1–3.2 (only the extension and encoder call
   would differ).

5. **Exactly which ΔE bar gates Apple-vs-Rust parity for this tier (§1.1, §4.1).**
   `docs/spec/06-cross-platform.md` is internally inconsistent: its invariants list
   (line 14) states "ΔE ≤ 1 target, ≤ 3 tolerance," but its own harness section
   (line 320) states the number actually enforced today is "current target ≤5;
   aspirational is ≤3" — a materially looser bar than the headline figure this spec
   (and, before this review pass, the original plan) cited as settled. This spec does
   not resolve which number Stage 5's Apple-vs-Rust-primitive parity gate (§4 item 1)
   should actually enforce for the display-preview tier specifically — that source
   document's own inconsistency needs resolving (either by the doc's owner or by
   Stage 5 picking one and stating why) rather than silently inherited here. Until
   resolved, Stage 5 should treat ≤3/mean, ≤5/p95 as a reasonable working interpretation
   consistent with both cited numbers, not as a number this spec asserts with
   confidence.

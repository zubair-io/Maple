# M3 — Local Adjustments & Repair (Milestone 15)

Design spec for GitHub milestone **15 · Local Adjustments & Repair**, tracked by epic
**#2445**. Covers the masking cluster (#358, #355, #1541, #360, #362, #361, #1478) and
the Local AI Inpainting epic (#1472). This is the spec `docs/features.md` and the epic
body point at; it did not exist in the tree before this PR.

## 1. Outcome

Most photographs can be finished entirely inside Maple: paint, drag, or AI-detect a
region, apply the same ten develop controls the whole image already has, and the
result round-trips through the XMP sidecar in a form Adobe Camera Raw and Lightroom
Classic can also read. Non-destructive object/person removal ("Heal") sits alongside
masking as a second, deterministic (non-generative) repair tool. Everything
participates in Undo/Redo, Copy/Paste, and history the way a global slider already
does.

Three things have to be true, and none are yet: a mask can be authored on both
shipping platforms (neither has any mask UI today); a Maple-authored mask opens in a
reference renderer and vice versa (today the wire format is private JSON no other tool
parses); and masks cover the shapes photographers reach for (only linear/radial
gradients exist — brush, range, and AI masks don't).

## 2. Current state, layer by layer

### 2.1 Math and data model — exists, shared, well-tested

`raw-core` implements the full evaluate-and-apply loop for two mask shapes.
**Types** (`raw-core/src/types/local_adjustment/mod.rs`): `Mask::Linear` (start/end,
feather) and `Mask::Radial` (center, radii, angle, feather, invert), normalized
`[0,1]` over the full oriented image; `LocalAdjustment { mask, adjustments }` pairs a
mask with a `PartialAdjustments` — the same ten controls a global adjustment has
(exposure, contrast, highlights, shadows, whites, blacks, saturation, vibrance,
temperature, tint), each an `Option<f32>` where unset is a true no-op (saturation/
vibrance still touch Oklab at `0`; temperature/tint engage a CAT16 matrix once
present at all). **Evaluation**: `stages/local_adjustments/mask.rs` computes the
per-pixel weight; `stages/local_adjustments/mod.rs` blends each control by it, between
dehaze and sharpen (`docs/pipeline.md`'s stage list). **GPU path**: closed as a gap by
#1698/PR #2343 — `raw-gpu/src/local_adjustments.rs` + `.wgsl` port the whole layer
stack into one dispatch, reading a flat `array<Layer>` buffer single-sourced from
`types/local_adjustment/flat.rs`; parity against the CPU reference gates at 1e-4.
**Wire (FFI/WASM)**: `MapleAdjustmentParams`/`MapleGpuLiveParams` carry a `(ptr, len)`
layer-stack tail on the same append-only convention as the tone-curve/Auto-Profile
arrays, so a pre-#1698 host gets an empty (bit-identical) stack rather than a broken
one.

**The one real functional gap**: `pipeline::tile` (`pipeline/tile/mod.rs`) — used by
deep zoom and padded-crop rendering — rejects any model with non-empty local
adjustments, the same contract as dehaze (#1084): mask coordinates are full-image
normalized and a tile crop has no offset plumbing to reinterpret them. Mask editing is
fit-zoom-only, full stop, on every platform, for the whole of M3.

### 2.2 Wire format — private, and about to be replaced

The only XMP representation is `papp:LocalAdjustments`, a single attribute holding
compact JSON (`types/local_adjustment/wire.rs`), read by one consumer
(`xmp/fields.rs`) and written by **nobody** — `raw-core::xmp` is a parser module with
no serializer for it, and neither Swift nor TypeScript models it at all.
`papp:InpaintRemovals` (`types/inpaint.rs`) is the same shape, for the same reason: no
reference renderer defines removal records, so there was never a canonical target.

Because nothing writes either attribute, no user sidecar on disk carries one except a
hand-authored fixture — which is why #358 needs no migration (§3.1). It also means
`papp:` values still round-trip safely despite being unmodelled: **XMP passthrough now
exists on all three hosts.** Apple had none — #2233 documented `XMPSerializer`
rebuilding sidecars from `(AdjustmentModel, CullingState)` alone, destroying anything
unmodelled including `crs:MaskGroupBasedCorrections` — but #2233 **closed** 2026-07-26;
Apple now has `XMPSerialization+Passthrough.swift` / `XMPPassthroughScanner.swift`.
TypeScript already captured and re-emitted unknown nodes. `docs/xmp-canonical-format.md`
documents both `papp:` fields as passthrough-carried. **This resolves the data-loss
risk several sub-issue threads below were written against** — an unmodelled mask
element from one platform is no longer silently destroyed by another. It remains true
that neither `papp:` field opens in ACR/Lightroom, which is the actual reason #358
exists.

### 2.3 UI — greenfield on both shipping platforms

Neither platform has a mask-editing surface; both have a placeholder that already
names its own ticket. **Apple** — `ToolDock.swift` renders Mask/Heal as
`DisabledDockPlaceholder`; `StackedAdjustmentsPanel.swift` renders both as
`SpecialToolButton(isEnabled: false)`, commented `Tool.mask`/`Tool.heal does not exist
yet`. No `Tool` case, no overlay, no Swift mirror — and there never will be a
_generated_ one: `local_adjustments` is deliberately excluded from codegen
(`types/adjustment/schema/mod.rs`, in `NON_COPYABLE_FIELDS` in `schema/groups/mod.rs`),
so encode/decode is permanently hand-written against `MapleCore/AdjustmentModel.swift`.
Build against the current canvas-first dock/panel pair (`PillHeader.swift` is the
chrome on every control variant today) — #355's own body still says "DetailPanel,"
which predates that shell. **Web** — `tool-dock.component.ts` has the same two
entries, `disabled: true`, tagged `ticket: '#1541'` (Mask) / `'#1472'` (Heal),
surfaced to screen readers as `"<label> — coming in <ticket>"`. The dead `mask-chip`
pair #1541's research flagged for deletion is already gone (#1837 shipped it). No TS
mirror for the same codegen reason. `CropOverlayComponent`
(`components/crop-overlay/`) is the closest precedent for an on-canvas SVG handle
layer with darkened-outside treatment — the template §4 builds on. **Windows** has no
develop-settings copy/paste at all (`docs/features.md`) and no ticket here; out of
scope for M3 UI (§7).

### 2.4 Mask variety — two of five shapes exist

`Mask` has exactly two variants. Brush (#360), range (#362), and AI subject/sky (#361)
don't exist anywhere — not the enum, not the evaluator, not any wire format. All three
tickets converge on the same two extension points (the `Mask` enum and the `match` in
`mask::evaluate`) and the same two prerequisites: a mask UI to hang a brush/eyedropper/
detect-button on, and an apply path fast enough that a strictly-heavier mask type isn't
first to blow the frame budget. #1698 resolved the second. #355/#1541 are the first.

### 2.5 Repair (inpainting) — engine phases 0–1 done, host-facing work open

Epic #1472 targets deterministic, local, offline object/person removal, distinct from
a future generative fill. Its design doc, `docs/design/2026-06-20-local-inpainting-
research.md`, **no longer exists in the tree** — removed in the 2026-09-01 docs
regeneration along with other archived plans — and #1472's body still cites it by
path. That's the same kind of dangling reference this document exists to fix for the
masking cluster; §8 carries it as an open decision.

Delivered, verified against the current tree: **Phase 0** (PR #1483, closes #1473) —
`view::agx_inverse`/`grade_inverse`, proving a patch baked at one grade and inverted to
scene-linear re-grades coherently under later exposure/WB changes. **Phase 1**
(PR #1500 closes #1499; PR #2388 closes #1486, closing #1865) —
`types::{Removal, BakeGrade, InpaintPatch}` (`types/inpaint.rs`);
`pipeline::apply_scene_linear_chain[_f32]_with_patches` compositing at the
pre-user-grade seam (before white balance, so the patch rides WB/exposure/tone/AgX
like sensor data); the `.maple/inpaint/<hash>.f16` codec (`pipeline/inpaint_store.rs`);
and `maple_apply_scene_linear_chain_with_patches` (+`_f32`) in
`raw-ffi/src/scene_linear_chain_patches.rs`. `Removal` round-trips through
`papp:InpaintRemovals`; patch pixels never enter XMP.

Not started: Phase 2 (Apple manual inpaint — LaMa/MI-GAN via ORT+CoreML, mask UX,
Swift use of the Phase-1 FFI), Phase 3 (Vision-based auto removal), Phase 4 (SAM
click-select, BiRefNet, optional diffusion Generative Fill), Phase 5 (web — explicitly
deferred by the epic, not merely unscheduled).

## 3. Per sub-issue: scope and design

### 3.1 #358 — XMP wire format: `papp:LocalAdjustments` → canonical `crs:*`

**Scope.** Replace the private attribute with what ACR/Lightroom already define:
`crs:GradientBasedCorrections` (linear), `crs:CircularGradientBasedCorrections`
(radial), and — landed alongside #360/#362, sharing the same container machinery —
`crs:PaintBasedCorrections` (brush) and nested `crs:RangeMask` (range). Each is a
nested `rdf:Description → rdf:Bag → rdf:li` structure: mask geometry as `crs:`
attributes on the `li`, one `crs:Local<Control>2012` attribute per adjustment. This
needs a state-tracking walker, not the flat attribute-only scan `xmp::parse` used to
require — but that walker already exists, in triplicate, from #365:
`raw-core/src/xmp/tone_curves.rs` (`CurveWalker`), Swift's
`XMPSerialization+ToneCurves.swift` (`ToneCurveWalker`), TypeScript's
`xmp-parser.service.ts` (`unknownNodes`). The mask walker is a template copy, not new
plumbing.

**Design — the mapping.** `Mask::Linear{start,end,feather}` → the gradient's point
pair plus its feather attribute; `Mask::Radial{center,radii,angle,feather,invert}` →
the ellipse attributes plus the invert flag. `PartialAdjustments`' ten fields map
one-to-one onto Lightroom's `crs:Local<Name>2012` family — no semantic gap, only a
coordinate-space/scaling check to verify by hand-rendering one fixture in ACR, as the
ticket specifies, rather than by spec alone.

**Blockers, now cleared.** The ticket named two sequencing hazards: #2233 (Apple
destroys unmodelled `crs:` elements) — **closed**, §2.2; collision with PR #2294
(byte-canonical harmonization, pinning golden literals with an attribute-ordering
contract: `xmp:` → `crs:` → `papp:` → `xmpMM:`, alphabetical within a band) —
**merged** 2026-07-26. #358 can start immediately; new `crs:` elements must slot into
the #2294 ordering contract, not reopen it.

**Deprecation.** Drop the `papp:LocalAdjustments` write path the moment the canonical
writer lands (nothing to migrate). Keep the reader arm one release as insurance for
hand-authored fixtures. **Ownership**: `raw-core` (writer + walker), then a pass
through Apple's/TypeScript's existing passthrough layers confirming the new nested
elements survive byte-canonical ordering — no new per-platform mask model needed yet.

### 3.2 #355 — Apple UI

A mask-list surface (add/remove/select, one row per `LocalAdjustment`, hung off the
current dock/panel pair — §2.3, not "DetailPanel") plus a canvas overlay drawing each
mask's handles: pin+axis for linear, center+radius for radial. The selected mask gets
a translucent weight-visualization overlay — a direct read of `w ∈ [0,1]`, testable
against `mask::evaluate`'s own output with no separate oracle — plus the permanently
hand-written Swift mirror into `AdjustmentModel.swift`. Uses the shared handle model
in §4. Apple only.

### 3.3 #1541 — Web UI (Pro Editor M3)

Activates the `Mask` dock entry (currently `disabled: true, ticket: '#1541'`).
Single-mask scope as written — the one requirement it dropped from its closed
duplicate #356 was a multi-mask list; §8 asks whether to pull that forward now that
#355 is speccing a list on the other platform. Same shared handle model as #355 (§4),
built on `CropOverlayComponent`'s existing pattern rather than a new mechanism. The
math this drives is already correct and already GPU-live on web specifically: because
the WASM entry parses XMP in Rust, a sidecar with `papp:LocalAdjustments` already
renders on the GPU-live canvas today with zero host change (PR #2343). #1541 adds the
_authoring_ surface to a render path that already works. Web only.

### 3.4 #360 — Brush masks

A third `Mask` variant recording per-pixel painted alpha. Two open storage questions
per the ticket (also §8): XMP shape (Lightroom's `crs:Mask` with
`crs:What="Mask/Paint"`, per-dab `crs:CenterWeight`/`crs:Radius`) and in-memory shape
(bitmap — faster to evaluate, matches how the GPU rasterizer reads a per-pixel weight
— vs. dab series — faster to edit, lossless round-trip). Scoping doc first, per the
ticket.

**Recommend** bitmap-in-memory, dab-series-on-disk: store the authored stroke as an
ordered dab series in `crs:PaintBasedCorrections` (byte-for-byte reference-compatible),
rasterize to a mask bitmap once per edit — not per frame — using the same GPU dispatch
shape #1698 built, and cache it the way `RenderedPreviewCache`/`TileKey` already fold
the sidecar mtime into their key (`docs/caching.md`): a brush mask is adjustment-model
content exactly like a slider value. **Ownership**: `raw-core` (variant/eval/wire,
following #358's precedent) then whichever platform has landed §4's handle model, in
parallel across platforms.

### 3.5 #362 — Range masks (color / luminance / depth)

`Mask::ColorRange`/`Mask::LuminanceRange` variants computing per-pixel weight from
image data (probe + smoothstep falloff) rather than geometry. UI: eyedropper + range
slider. Wire under `crs:RangeMask`, nested inside a parent gradient/circular/paint
mask the way Lightroom composes range masks as _refinements_ rather than a standalone
type — confirm against a reference-authored sidecar before locking the schema, same as
#360. Depth is named in the ticket title but Maple has no depth data source anywhere
in the pipeline today — treat it as a documented extension point, not an M3
deliverable (§7). **Ownership**: `raw-core` then Apple/Web UI in parallel, once §4
exists.

### 3.6 #361 — AI subject / sky masks

Three open questions per the ticket: model choice, where the mask lives, latency
budget.

**Model choice — recommend** reusing the inference stack #1472 already builds rather
than a second ML runtime: ORT + CoreML on Apple, the pairing Phase 2/3 uses for
LaMa/MI-GAN and Vision segmentation. Two tiers, not one model for both cases: Apple
Vision's built-in segmentation (zero download, already #1472's chosen "auto" path) for
subject masks, and a lightweight sky-specific binary-segmentation model for sky — sky
is a narrow, well-separated class that doesn't need a general segmenter's cost. A
full SAM-class click-anywhere segmenter is a plausible escalation (mirroring #1472
Phase 4) but not the minimum for what the ticket actually scopes.

**Latency/storage — recommend**: AI mask generation is one-shot (tap "detect
subject"), not per-tick — it needs to feel responsive for a single interaction, not
fit the 16ms budget. Rasterize once, cache the bitmap content-addressed the way
`.maple/inpaint/<hash>.f16` already caches inpaint patches, and record a reference +
checksum in the XMP entry rather than re-deriving on every open — reusing an existing
pattern instead of inventing a third caching scheme this milestone. **Ownership**:
`raw-core` (variant/eval/wire) plus Apple ORT+CoreML integration; web's model story is
genuinely open and should be scoped once #1472 Phase 2 proves the Apple integration,
not speculatively now (YAGNI, CLAUDE.md §7).

### 3.7 #1478 — Parity fixture (validates #1450's math against ACR)

Add a manifest case with a masked region (contrast/highlights/shadows + a color move)
and its ACR reference, plus a `budgets.json` entry, gated by
`src/scripts/test_color_pipeline.sh`. **Blocked on #358, not merely helped by it**:
`maple-cli batch` renders each case from one sidecar (`maple-cli/src/commands/
batch.rs`), and that same sidecar produces the ACR reference. ACR can't read
`papp:LocalAdjustments` — it would render unmasked, and the harness would silently
diff Maple's masked output against ACR's unmasked output, passing without validating
anything. **Ownership**: `raw-core`/harness, no UI dependency — starts the moment #358
has a writer, in parallel with #355/#1541.

### 3.8 #1472 — Local AI Inpainting (Remove), Phases 2–5

Phases 0–1 are done (§2.5); not re-specced here. Phase 2 (Apple manual inpaint UX +
LaMa/MI-GAN wiring) is next and Apple-only, per the epic. It shares the ToolDock/
StackedAdjustmentsPanel "Heal" placeholder with the masking work (§2.3) but is
functionally separate — repair, not adjustment — and doesn't block or get blocked by
#358/#355/#1541 at the engine level, since it already has its own wire format and
compositing seam. The real shared cost: both "Mask" and "Heal" need a tool-arming
interaction on the same dock, so #355 and Phase 2 should agree who lands the shared
`Tool` enum plumbing first rather than each adding a case and merge-conflicting the
switch statement (§5, §8).

## 4. Shared canvas-handle interaction model (Apple + Web)

Both #355 and #1541 need the same primitive: a canvas overlay with drag handles for a
mask's geometry, reading/writing normalized `[0,1]` coordinates. Neither the Maple UI
catalog nor the per-component contracts under `docs/design/maple-ui/components/`
define a "mask handle overlay" entry yet — the closest catalog row is **Crop
Overlay**, shipped on Web/Apple/Windows already, and the right template: it draws
interactive handles over the live canvas in the same coordinate space the render
pipeline uses; Web's `CropOverlayComponent` already solves the darken-outside
treatment masking needs for weight visualization (show what _is_ affected — the same
idiom inverted); and it's the one place a normalized cross-platform drag-handle
contract already ships in production rather than needing to be designed from scratch.

What's different, and needs new design: a crop overlay has one active shape and no
"kind" (always a rectangle); a mask overlay needs a **selected-mask** concept (only
the active `LocalAdjustment`'s handles render) and **two handle kinds** (linear =
pin + perpendicular axis; radial = center + ellipse handle + rotation). Recommend one
overlay component per platform dispatching on `Mask`'s variant for the handle-set,
mirroring how `mask::evaluate` is one function with a match, not two functions. This
should become an actual `docs/design/maple-ui/components/` entry once #355/#1541 land,
per that doc set's own rule that every organism gets a contract file.

## 5. Sequencing

**#358 → {#355, #1541} → #360 → #362 → #361**, with #1478 parallel to #355/#1541 once
#358 lands, and #1472 Phase 2 independent throughout.

- **#358 first**: every other ticket writes XMP through the format it defines, or
  needs its writer to construct a fixture (#1478). No UI dependency; unblocked today.
- **#355 / #1541 in parallel** once #358 lands: independent platforms, a shared
  _design_ contract (§4) but no shared code — sequencing them serially would be an
  artificial dependency the two teams don't actually have.
- **#360 after #355/#1541**: nowhere to hang a brush tool until a mask surface exists,
  and brush carries heavier per-pixel cost than parametric masks — it shouldn't be
  first to discover whether the interactive budget holds (#1698 already answered that
  for Linear/Radial).
- **#362 before #361**: range masks are pure math (probe + smoothstep); AI masks add a
  whole model-selection and asset-caching question on top of the same "third variant"
  plumbing. Landing the cheaper variant first validates the extension path before AI
  has to reuse it under more constraints.
- **#1472 Phase 2 is independent** at the engine level; the only coordination point is
  the shared `Tool` enum slot on Apple (§8).

## 6. Acceptance tests

- **Parity fixture (#1478)**: a masked-region case in `test-fixtures/references/`,
  gated by `test_color_pipeline.sh`, budgets ceilinged 5–10% above measured mean/p95/
  max/bias per the standard harness workflow — the one gate validating color math
  end-to-end against an independent renderer.
- **Byte-canonical XMP tests**: extend PR #2294's golden-literal tests
  (`XMPCanonicalFormatTests.swift`, `xmp-canonical.spec.ts`, `raw-core`'s own XMP
  round-trip tests) with a linear+radial-mask case, asserting serialized bytes match a
  committed golden and round-trip to an identical `LocalAdjustment` list — for every
  new variant as it lands, not only once at #358.
- **Pixel-parity gates**: extend PR #2343's GPU-vs-CPU analytic parity harness (1e-4
  gate) and the FFI live-parity gate's "masked" case per new variant. Cheaper than the
  ACR fixture; should run on every PR touching `mask::evaluate` or the WGSL kernel.
- **Interactive-surface tests**: a `SliderMatrixUITests`-style XCUITest exercising the
  new overlay (drag a handle, assert the mask moves and the weight overlay updates)
  belongs with #355, following `docs/apple.md`'s UITest harness pattern; the web
  equivalent is a Playwright e2e case on `CropOverlayComponent`'s sibling.

## 7. Non-goals

- No layer compositor or generative scene replacement (epic's own non-goal — bounds
  #361 and #1472 specifically: subject detection produces a mask, not a pixel layer;
  Heal is deterministic removal, not diffusion fill, which is Phase 4's separate,
  not-in-this-milestone escalation).
- No platform-specific mask schema — one `crs:*` mapping, shared by every writer.
- No depth-based range mask in M3 — no depth data source exists today (§3.5); the
  variant stays a documented extension point, not a delivered control.
- No Windows masking or repair UI — no ticket exists, and Windows lacks even
  develop-settings copy/paste, a simpler precondition that hasn't shipped there yet.
- No zoomed/tiled mask editing — `pipeline::tile` keeps rejecting active local
  adjustments for the whole of M3; tile-relative mask coordinates are their own
  correctness/performance surface, out of scope here.
- No web AI-mask model integration in M3 (§3.6) — scope once #1472 Phase 2 proves the
  pattern on Apple.
- No general SAM-class click-anywhere segmenter in #361's M3 slice — ship the two-tier
  Vision + sky-specific model first; full SAM is a future escalation, not phase-1.

## 8. Open decisions

1. **Should #1541 adopt the multi-mask-list requirement now?** #1541 scopes
   single-mask, dropped from closed duplicate #356. #355 (Apple) is now speccing a
   list UI as baseline. Shipping web single-mask creates a cross-platform capability
   gap on day one, not a temporary one. **Recommend**: pull the list into #1541's scope
   now — the marginal cost is mostly the list-management UI #355 already needs a spec
   for, and reconciling divergent data-shape assumptions (web: one; Apple: N) later is
   more expensive than aligning now.

2. **Who lands the shared Apple `Tool` enum plumbing — #355 or #1472 Phase 2?** Both
   need a case on the same enum and the same dock/panel switches. Parallel landings
   risk the shared-resource merge collision CLAUDE.md's mergeability rule warns about
   (two textually clean PRs, wrong together). **Recommend**: whichever ships first adds
   both cases (`.mask` and `.heal`) even though only one ships behavior, so the second
   PR fills in behavior behind an existing case instead of extending the enum again.

3. **What restores or replaces the deleted inpainting design doc?** #1472's body still
   cites `docs/design/2026-06-20-local-inpainting-research.md`, gone since the
   2026-09-01 docs regeneration, which deliberately removed archived plans.
   **Recommend**: update #1472's body to point at this document's §2.5/§3.8 plus the
   PRs carrying the technical detail now (#1483, #1500, #2388) — the same resolution
   this document gives #2445. Filing that as a small separate follow-up, since editing
   another epic's body is outside this document's brief.

4. **Exact `crs:` attribute names for #360/#362's Maple-specific extensions.**
   Lightroom defines names for its own shapes; #361's AI mask has no Lightroom
   equivalent to borrow from. **Recommend**: nest AI masks inside
   `crs:PaintBasedCorrections` as a bitmap-backed paint mask (structurally what they
   are once rasterized) with a Maple-private `papp:` sibling recording model
   provenance (id, version, confidence) — a reference renderer sees a valid paint
   mask; Maple-specific metadata stays in the `papp:` namespace #358 already
   establishes.

## 9. Implementation order

```
1. #358   XMP wire format                          (raw-core only, unblocked today)
   │
   ├─→ 2a. #355   Apple UI                          ─┐  parallel once #358 lands
   ├─→ 2b. #1541  Web UI                             │  (independent platforms,
   │                                                  │   shared design in §4)
   └─→ 2c. #1478  Parity fixture                    ─┘  (no UI dependency)

3. #360   Brush masks           (after 2a/2b: needs a mask UI to build against)
4. #362   Range masks           (after #360: reuses its variant/wire extension path)
5. #361   AI subject/sky masks  (after #362: reuses the same path, adds model + cache)

Independent track, any time: #1472 Phase 2 (Apple manual inpaint), coordinating with
#355 only on the shared Tool-enum plumbing (§8, decision 2).
```

Step 2 is parallelizable across teams today once #358 merges. Steps 3–5 are
sequential by design (§5) — each variant is cheaper once the previous one has proven
the extension pattern — but within a step, the `raw-core` variant/eval/wire work and
the per-platform UI for that variant are themselves parallelizable, once the
`raw-core` half has a reviewed shape for the UI to bind to.

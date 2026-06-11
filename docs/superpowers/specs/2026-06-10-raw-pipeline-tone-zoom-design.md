# RAW pipeline, tone & zoom — design for the RapidRAW/RawTherapee-inspired feature set

**Date:** 2026-06-10 · **Status:** awaiting review · **Tickets:** filed on approval (see §7)

The requested feature list is RapidRAW's release notes v1.4.2–v1.5.0 (verified against
github.com/CyberTimon/RapidRAW releases). This design maps each item onto Maple's
architecture, using RapidRAW and RawTherapee as prior art. §10 extends coverage to the
rest of the missing-feature inventory: the new-UI editor tools that exist as stubs today
(HSL, crop, presets are in `STUB_TOOLS`; vignette/grain/split-tone pills write schema
fields the pipeline ignores, #643), plus small pipeline gaps surfaced by the research.
§11 is the ledger of larger absent features deliberately not designed here.

## 0. Sources and licensing

- **RapidRAW is AGPL-3.0, RawTherapee is GPL-3.0.** No code, shaders, or constant tables
  may be copied into Maple. This spec describes algorithms at the published-math level
  (Schlick 1994 bias, Dabov et al. 2007 BM3D, joint-bilateral filtering) with Maple's own
  parameterization; every kernel below is implemented clean-room from this spec.
- **BM3D legal note:** the 2007 algorithm itself appears unpatented, but the Tampere
  reference code is non-commercial-only and variant patents exist (e.g. US9123103B2).
  Implementation must be clean-room from the paper (it is, by the rule above), and a
  patent review of US9123103B2's claims is a release gate for §3.2.

## 1. Assumptions

1. "Image title" in the request is read as **image tiling** ("edit the smaller section of
   image"), consistent with the adjacent zoom/sizing asks.
2. Zoom/pinch/tiling target the **new responsive UI** (epic #577: S4 loupe, S5 editor) on
   **both platforms**. The full zoom system in docs/zoom.md exists only in the legacy
   `FullImageView` (which the responsive program replaces); the new Apple `EditorView`
   hardcodes `pixelScale: 0` (fit-only — no zoom, pan, or pinch while editing), the new
   web editor wraps `ImageCanvasComponent` (stepped zoom buttons + unanchored wheel, no
   pinch, full-res render per tick), and the web loupe does not exist (library cell tap
   routes straight to the editor, #789). docs/zoom.md is treated as the reference design
   to be adopted by the new UI, not as shipped behavior.
3. ACR references remain the color baseline (per project memory and #443 history); nothing
   here re-litigates the view transform.
4. New GPU work lands in the unified **wgpu/WGSL** pipeline (post-#925/#1063/#1064). The
   legacy MSL chain is being removed (#1043); new stages are implemented in Rust (CPU
   reference) + WGSL only. Implementation checkpoint: if the `MAPLE_GPU_LIVE=0` fallback
   still routes through MSL when a phase lands, that phase must extend the fallback too —
   all enabled render paths render the new stages identically.

## 2. What Maple already has (gap matrix)

| Requested feature | Maple today | Gap |
| --- | --- | --- |
| AgX tone mapping, film-like rolloff | **Shipped.** AgX (Blender/Sobotka lineage — same source RapidRAW copied via darktable) is the view transform: inset/outset matrices, ratio-preserving sigmoid, Oklab gamut compression. Path-to-white on overexposure already behaves as requested. | None for the rolloff ask. Per-image Auto Profile wiring continues under existing #530/#536/#394 — not re-specced here. |
| True exposure compensation | **Shipped.** `exposure` is `×2^EV` in scene-linear Rec.2020 (stage 13). | None. |
| Brightness (midtones) slider | Absent — no midtone control between exposure and tone curves. | §4.1. |
| Detail-masked shadows/highlights | S/H/whites/blacks exist but are purely per-pixel luminance-keyed; shadows only acts below Y≈0.1, highlights only above Y=1.0. | §4.2. |
| Chroma-noise-suppressing pre-processing | `nrColor` (NLM on Oklab a/b) is a late-chain slider stage, ~2.5 s at default on 25 MP, excluded from the slider-tick path. Nothing runs at decode time. | §3.1. |
| BM3D | Absent. | §3.2. |
| Zoom + pinch | **Legacy** `FullImageView` (Apple): full system (fit→800%, pinch, pan, keyboard) — being replaced by the responsive program. **New UI:** Apple `EditorView` is fit-only (`pixelScale: 0` hardcoded); web editor (`ImageCanvasComponent` via `<editor-image-canvas>`) has stepped zoom buttons + unanchored wheel, no pinch; web loupe absent. | §5.0. |
| Zoom-to-fit renders low-res | The render machinery is zoom-aware on Apple (`CanvasMath.refinedTargetSize = native × min(pixelScale, 1)`, refine skipped at fit) and the new `EditorView` already runs on `EditSession`/`CanvasMath` — but with zoom pinned to fit it can never exercise it. Web: **no** — every slider tick decodes and renders full resolution; the sized FFI entry (`maple_render_bytes_scene_linear_sized`) exists but web never calls it. | §5.0–5.1. |
| Edit only the visible section (tiles) | Apple deep-zoom tile code exists but is gated off (`EditSession.deepZoomEnabled = false`) by tile-seam color parity, ticket #11. FFI tile entry points exist. | §5.3. |
| New-UI editor tools: vignette / grain / split tone | Pills shipped, fields persist to XMP, **pipeline ignores them** (identity stubs, #643). | §10.1–10.3. |
| New-UI editor tools: HSL / crop / presets | Declared stubs (`STUB_TOOLS` in tool-model.ts); no schema fields exist for HSL or crop. | §10.4, §10.5, §10.7. |
| Hot/dead-pixel suppression | Absent (RT ships it pre-demosaic; flagged Phase-4+ in spec docs). | §10.6. |

## 3. Noise: a three-tier architecture

The end state mirrors what makes RapidRAW's noise story coherent, expressed in Maple's
scene-referred terms:

1. **Decode-time chroma pre-filter** (§3.1) — biases residual noise toward luminance once,
   inside the cached decode. Cheap, camera-agnostic.
2. **Live NLM sliders** (existing `nrLuminance`/`nrColor`) — unchanged in this design.
3. **BM3D deep denoise** (§3.2) — heavy, cached, input-referred; for high-ISO rescue.

### 3.1 Decode-time chroma pre-filter

**What:** a luma-guided joint-bilateral filter applied to chroma only, as the last step of
the decode product (after DCP colorimetry and post-DCP highlight recovery, before
auto-exposure/WB-delta and all user adjustments). It lands inside the decoded scene-linear
buffer, so its per-slider-tick cost is zero.

**Why there:** noise is a property of capture, not of edits — RawTherapee runs its
false-color suppression immediately post-demosaic (YIQ median on I/Q only) and RapidRAW
runs its chroma filter once at decode and caches it. Placing it post-DCP means it operates
in a stable colorimetric space (scene-linear Rec.2020) for every camera.

**Algorithm (clean-room):**
- Compute `Y = dot(rec2020_luma, RGB)` per pixel. Form opponent chroma `C1 = R − Y`,
  `C2 = B − Y` (linear 3×3 algebra; no Oklab round-trip — ticket #05 flagged that cost).
- Filter C1/C2 with a sparse cross-bilateral kernel: ~9 taps on an off-center sparse grid
  spanning ≈9 px (decorrelates from Bayer/X-Trans CFA periodicity), range weight driven by
  **luma difference only** (rational/Cauchy falloff), plus a quadratic spatial penalty.
  Luma edges stop chroma diffusion; `Y` itself passes through untouched — that is the
  "bias noise toward luminance" property, exactly.
- **Chroma-magnitude clamp:** if the filtered chroma magnitude exceeds the original,
  rescale back to the original magnitude. Smoothing may only desaturate noise, never bleed
  color — this prevents blotching.
- Reconstruct `R = Y + C1'`, `B = Y + C2'`, `G = (Y − wR·R − wB·B)/wG`.

Unlike RapidRAW, **no sharpening half**: Maple already has capture sharpening
(Richardson-Lucy) and texture as separate, parity-gated stages.

**Parameter & schema:** `papp:ChromaPrefilter`, 0–100. One new field in
`ADJUSTMENT_SCHEMA` → codegen → Swift/TS; XMP writers ×3; round-trip tests. Exposed in the
Detail panel next to the NR sliders. Changing it invalidates the decoded-image cache entry
(it is part of the decode key) — acceptable for a set-rarely control; the UI commits on
release, not per tick.

**Default calibration (explicit procedure, not a TBD):** implement with default 0, then run
`src/scripts/test_color_pipeline.sh` sweeps at {0, 25, 50}. Flip the shipped default to the
best value only if the full-fixture matrix is neutral-or-better (means and biases), in the
same commit that re-ratchets `budgets.json`. The ACR references were rendered with ACR's
own default color NR, so a default-on pre-filter plus `nrColor=25` risks double-cleaning;
the sweep decides with numbers, not eyeballs.

**Gates:** on a uniform grey card every tap sees equal luma → the filter is exactly
identity, so `test_synthetic_grey.sh` flatness invariants and all existing grey predictors
pass unchanged. CPU cost is O(N)·~9 taps at decode time (hidden inside the 250–1000 ms
cold-open budget); no GPU port needed since it never runs per tick.

### 3.2 BM3D deep denoise

**Product shape — pipeline stage, not an export tool.** RapidRAW ships BM3D as a modal
tool that writes a `<stem>_Denoised.tiff` next to the original. That forks the edit
history out of the RAW workflow and violates Maple's sidecar-is-the-contract invariant.
In Maple, BM3D is a non-destructive, XMP-parameterized stage whose cost is amortized by a
cache.

**Placement:** input-referred, immediately after the §3.1 pre-filter, before all user
adjustments — same rationale (denoising is a capture-domain operation; ACR's own deep NR
runs input-referred). It therefore composes into the decode product.

**Algorithm (clean-room from Dabov et al. 2007):** two-stage BM3D — hard-threshold pass,
then Wiener pass guided by the basic estimate. Operate on opponent channels (Y, C1, C2 as
in §3.1): joint block-matching on all three channels (one match list), with chroma
thresholded harder than luma (σ_chroma ≈ 1.8×σ_luma — keeps residual noise luminant,
consistent with tier 1). 8×8 blocks, DCT-II patch transform + 1-D Walsh–Hadamard across
the group, reference-patch stride ~6, search window ~19×19, group size ≤16. Single
strength parameter maps to σ and match thresholds. A final high-frequency re-injection
(unfiltered minus Gaussian-blurred luma, scaled by strength) guards against plastic skin.
Parallel CPU (rayon) first; a WGSL compute port is a follow-up only if profiling demands
it — the cache makes CPU latency a one-time cost per setting.

**Parameter & schema:** `papp:DeepDenoise`, 0–100, default 0 (off). Orthogonal to the NLM
sliders (which continue to operate late-chain on top). Commit-on-release slider with a
determinate progress indicator (runtime is seconds on big files — the perf invariants
require visible progress, and RapidRAW streams "Step 1/2 — NN%" the same way).

**Caching:** the decoded-image cache entry is keyed on
`(asset, decode params, chromaPrefilter, deepDenoise)` and stores the post-NR scene-linear
buffer. It must **not** key on sidecar mtime — the sidecar autosave loop already causes
spurious decode invalidation on Apple (project memory; targeted fix independent of this
design). Web mirrors the key in its in-memory/IndexedDB equivalents.

**Gates:** on noiseless synthetic grey, hard-thresholding removes nothing → identity;
flatness invariants hold. Real-fixture behavior is gated by the parity harness with
`deepDenoise > 0` cases added to the slider-matrix set. Determinism requirement: identical
output across platforms and thread counts (fixed-point accumulation or deterministic
reduction order — thread-count-dependent float summation would break WASM/Apple parity).

## 4. Tone: brightness + detail-masked shadows/highlights

### 4.1 Brightness (midtone) slider

**Semantics:** exposure stays a pure linear gain (true exposure compensation — already
matching the request). Brightness moves **midtones only**, pinning deep shadows and the
highlight end, in scene-linear space, hue-preserving.

**Prior art:** RawTherapee builds a gamma-space NURBS pinned at (0,0)/(1,1) with toe/
shoulder control points; RapidRAW uses a Schlick rational bias on luma with chroma
management. Both are display-referred formulations. Maple's house idiom for scene tone is
smoothstep-weighted uniform gains (whites, blacks, shadows all work this way), which keeps
closed-form predictors trivial — so:

```
Y    = dot(rec2020_luma, RGB)
w(Y) = smoothstep(0.05, 0.25, Y) · (1 − smoothstep(1.0, 4.0, Y))   // midtone band
gain = exp2(0.7 · b/100 · w(Y))                                     // b ∈ [−100, +100]
RGB' = RGB · gain
```

- C¹-smooth, exactly 1.0 at the histogram ends (Y ≤ 0.05 stays the blacks/shadows
  sliders' domain; Y ≥ 4.0 = scene ref-max stays exposure/highlights territory).
- Uniform per-pixel scalar → hue-preserving by construction, same proof obligation as the
  existing scene tone controls (pin with the same hue-preservation unit tests).
- The 0.05/0.25/1.0/4.0/0.7 constants are initial values calibrated against the
  slider-matrix harness before merge; the calibration gate is "monotone, midtone-pivoted,
  ends pinned" plus visual-budget compliance, not ACR equality (this is a `papp:` slider
  with no ACR counterpart).

**Position:** inside `scene_tone_controls`, after exposure, before highlights/shadows/
whites/blacks — predictors compose left-to-right as today.

**Schema:** `papp:Brightness`, default 0. **Not** `crs:Brightness` — that key is ACR
process-version-2010 with different semantics (default +50, removed in PV2012); reusing it
would corrupt Lightroom interop. Schema → codegen → XMP ×3 → round-trip tests, as §3.1.

**Predictor:** `predict_brightness(y, b)` is the formula above — closed form, added to
`test_support::predictions` and `test_grey_adjustments.sh` in the same PR as the stage.

**GPU:** one new uniform + ~6 lines in the scene-tone WGSL kernel; no new buffers
(respects the ≤4 storage buffers/stage budget); parity-gated like every stage change.

### 4.2 Shadows/highlights rework with tonal detail masks

Two changes, shipped together because both alter slider response: **wider tonal ranges**
and a **local-detail (halo-protection) mask**.

**Why ranges too:** today shadows only lifts Y < 0.1 and highlights only compresses Y > 1.0
— positive highlights values do nothing to a bright-but-unclipped sky. That is the
documented "slider dulls the image without revealing detail" failure RapidRAW's v1.4.2
rework addressed. Target response (calibrated against the slider-matrix ACR references):

- **Shadows:** weight `w_s(Y) = (1 − smoothstep(0, T_s, Y))²` with `T_s = 0.25` (was 0.1),
  multiplier `mix(1, exp2(s/100 · K_s), w_s)`, gain capped (≈4×) so −100/+100 stay usable.
- **Highlights:** weight `w_h(Y) = smoothstep(0.4, 1.0, Y)`; the recovery direction
  compresses luminance toward the knee with the existing hue-preserving uniform-scale
  construction (now engaging below 1.0, strongest above); the opposite direction gains
  under the same weight. **Sign convention is unchanged from the current implementation**
  (existing sidecars must not invert) — only the engagement range and mask are new.
  Above-knee behavior keeps the current `Y' = 1 + (Y−1)/h_denom` compression so scene
  range is shaped, never clipped — AgX still owns final path-to-white.

**The detail mask (RapidRAW-style, chosen over RT's guided filter):**

```
Yb   = gaussian(Y, σ = σ_ref · longEdge/2000)        // σ_ref ≈ 15 px, calibrated
edge = |sqrt(Y) − sqrt(Yb)|                           // perceptual-ish edge measure
halo = smoothstep(E0, E1, edge)                       // E0≈0.05, E1≈0.25, calibrated
mult = mix(mult(Yb), mult(Y), halo)                   // regional vs per-pixel
```

In smooth or finely-textured regions the **blurred** (regional) luma drives the
multiplier, so every pixel of a texture patch receives the same gain — local contrast
ratios are preserved and pushed shadows stop going muddy. At strong edges the mask falls
back to per-pixel response, which is what prevents halos. This is one separable Gaussian
of a single channel per render — infrastructure the pipeline already has for clarity/
texture, on CPU and in WGSL. Resolution-invariance follows the existing convention: σ
scales with image long edge (clarity does the same), so fast-phase, refine, and export
agree.

*Alternative considered:* RawTherapee's guided-filter mask (radius 40, 4th-power tonal
width, subsample 4). Better edge fidelity in extreme cases, but a guided filter is a new
multi-pass primitive in WGSL (box means of I, p, I·p, I²) with more intermediate textures
against the 4-buffer budget, and RapidRAW's field results show the cheap mask achieves the
product goal. Revisit only if calibration can't kill halos at σ/E0/E1.

**Predictor compatibility:** on a uniform grey card `Yb = Y`, the mix degenerates to the
per-pixel curve, and predictors stay closed-form. They must be **updated** (new T_s, new
weights) in the same commit, with the no-new-failures rule against main's existing
predictor set, and slider-matrix budgets re-baselined where response intentionally moved.

**Behavior change policy:** existing sidecars keep their `crs:Shadows2012`/
`crs:Highlights2012` values but render through the new response — no process-version gate.
Rationale: budgets are loose (mean ≤ 25), the product is pre-GA, and a PV mechanism is
real complexity. This is a named decision for review, with the alternative (gate behind
`crs:ProcessVersion`) explicitly rejected, not forgotten.

**Tile awareness:** both σ-blur and NR kernels register their effective radius with the
deep-zoom overlap calculator (§5.3) — the S/H mask must not reintroduce seams.

### 4.3 AgX, rolloff, exposure — no new pipeline work

AgX is shipped and is the same lineage RapidRAW ported (verified constant-level against
darktable's Blender-like primaries). "Reworked highlight rolloff / exposure behavior"
decomposes into: exposure semantics (already correct, unchanged), highlight-slider
engagement below clip (§4.2), and shoulder behavior (AgX, shipped; per-image shaping
continues under the Auto Profile track #530/#536/#394). Adding a user-facing shoulder
control or alternate looks ("Punchy") stays out of scope — it would fight the ACR-parity
baseline and the Auto Profile direction.

## 5. Zoom and tiled rendering — in the new responsive UI

Everything in §5 lands in the responsive-program surfaces (epic #577): the S5 editor on
both platforms, and the S4 loupe as a consumer of the same primitive. The legacy
`FullImageView` gets no new work — it is the donor, not the target.

### 5.0 Zoom while editing (both platforms)

The product ask: pinch/zoom into a section of the image **inside the editor**, with
rendering that follows zoom (fit = proxy resolution, 100% = pixel-perfect, §5.1/§5.3 for
how that render happens). The docs/zoom.md `pixelScale` model is adopted wholesale —
0 = fit, 1.0 = pixel-perfect in real (dpr-aware) pixels, cap 8.0, snap-to-fit below
`fit × 1.02` — as a shared canvas capability:

- **Apple:** extract the zoom/pan/gesture host from `FullImageView` (gesture handling,
  pan clamping, zoom badge, `CanvasMath` plumbing) into a reusable canvas host and wire
  `EditorView` to a live `pixelScale` instead of the hardcoded 0. The render side needs
  nothing: `EditorView` already runs on `EditSession`/`CanvasMath`, whose zoom-aware
  fast/refine targets and visible-rect refine are shipped and exercised by the legacy
  view. S4's `LoupeView` adopts the same host under #577 (its phone spec already calls
  for pinch `[1, 6]` + double-tap).
- **Web:** the same model implemented in `ImageCanvasComponent` (`<editor-image-canvas>`,
  shared by the S5 editor in both the `maple` and `maple-syrup` apps): replace the
  stepped `ZoomLevel` (0.25/0.5/1/2/4/fit) with continuous `pixelScale`, add the gesture
  set below, render targets per §5.1.

**Gesture arbitration.** The S5 editor already owns canvas gestures for editing (S5b:
canvas drag adjusts the armed tool at 0.5:1; desktop scroll wheel nudges the armed tool;
bare `0` resets the armed tool). Zoom must compose without breaking those contracts:

| Input | At fit | Zoomed in (pixelScale > fit) |
| --- | --- | --- |
| Pinch (touch) / trackpad pinch (web: `wheel` + `ctrlKey`) | Zoom, anchored at gesture centroid/cursor | Same |
| One-finger / mouse drag on canvas | Inert — canvas tool-drag was removed from the product per #875 (the original S5b 0.5:1 mapping no longer ships); tool adjust lives on the drag bar / wheel detents | **Pan** |
| Plain wheel over canvas | Armed-tool nudge ±1/detent (S5, unchanged) | Pan (two-finger scroll = pan when zoomed) |
| Cmd/Ctrl + wheel | Zoom anchored at cursor | Same |
| Double-tap / double-click | Toggle fit ↔ 100% | Same (returns to fit) |
| Keyboard | `Cmd/Ctrl+0` fit, `Cmd/Ctrl+1` 100% (legacy Apple convention; bare `0`/`1` stay S5 tool-reset/rating) | Same |

Two intentional divergences, called out for review: the editor's double-tap toggles
fit ↔ 100% (pixel-perfect is what you need to judge NR/sharpening) while the S4 loupe
keeps its specced 1× ↔ 2.5×; and bare `0`/`1` remain S5 tool keys, so fit/100% take the
modifier — matching the legacy Apple shortcuts.

Zoom indicator badge (percent, always visible) ships on both platforms, per docs/zoom.md.

### 5.1 Web render parity: proxy-resolution rendering (fit = low-res)

Today the web path decodes and renders **full resolution on every slider tick** and draws
into an image-sized canvas backing store (12288-px-wide canvas for a 100 MP file at 100%).
Apple's contract (docs/zoom.md) is the design; web implements it:

1. **Viewport-sized decode:** expose `maple_render_bytes_scene_linear_sized` through
   raw-wasm and `raw-pipeline.service.ts` (`decodeSceneLinearSized(maxLongEdge)`), called
   with `viewportPx × devicePixelRatio`. The FFI exists and is tested; this is wiring.
2. **Two-phase render:** fast phase at viewport resolution per tick (16 ms budget), the
   existing 150 ms-debounced refine at `native × min(pixelScale, 1)` — same formula and
   floor as `CanvasMath.refinedTargetSize`. At fit zoom the refine target equals the fast
   target, so refine is skipped — "zoom to fit renders only a lower-res image", exactly.
3. **Canvas rework:** viewport-sized backing store (`viewport × dpr`), pan/zoom as a draw
   transform, never an image-sized canvas. Keep the `display-p3`/srgb tagging exactly as
   is (load-bearing, see CLAUDE.md note).
4. The decoded scene-linear buffer uploads to the WebGPU device once per decode and stays
   resident; per-tick work is uniforms + dispatch, mirroring Apple.

### 5.2 Web zoom mechanics (implementation of §5.0)

- **Touch pinch:** Pointer Events two-pointer tracking; scale = current/initial pointer
  distance, multiplied into a start-captured pixelScale (the same compounding bug Apple's
  `pinchStartScale` guards against), anchored at the gesture centroid.
- **Trackpad pinch:** browsers deliver macOS/Windows trackpad pinch as `wheel` events
  with `ctrlKey` — route to zoom (anchored at cursor) and `preventDefault` to stop
  browser page zoom. Plain wheel keeps its S5 meaning per the §5.0 table (tool nudge at
  fit; pan when zoomed).
- One-finger drag routes per the §5.0 table (tool adjust at fit, pan when zoomed);
  fit-mode horizontal swipe stays filmstrip/next-image navigation.
- Fit / 100% buttons (exist today) rebind to pixelScale; `Cmd/Ctrl+0`/`Cmd/Ctrl+1`
  shortcuts per §5.0.

Renders at zoom reuse §5.1's target-size formula. Until §5.3 lands, 100% zoom on web
renders full-native on refine — same as Apple's current gated state, slow but correct.

### 5.3 Deep zoom: un-gate tiles via stage-class overlap (the #11 fix)

Apple's tile path exists (`EditSession+DeepZoom.swift`, tile FFI entries with
`overlap_px`) but is disabled: a fixed 35 px overlap seams on local-context stages. The
reason it can never work as a single constant: spatial radii scale with image long edge —
clarity's 40 px @2000-ref radius is ≈246 px on a 12288-px image; a Gaussian needs ~3σ of
valid context. RT and RapidRAW point at the same two-part answer (32×skip borders / 2048+
128 tiles for local ops; full-frame-at-proxy escape hatch for global ops):

**Classify every pipeline stage:**

| Class | Stages | Tile policy |
| --- | --- | --- |
| Point ops | WB, exposure, brightness, S/H curves (given mask input), vibrance, saturation, AgX, curves | No overlap needed |
| Small-kernel | texture (≈3 px·scale), capture sharpening (σ ≤ 3), NLM NR (≤ 7×7+5×5), §4.2 mask blur if σ·scale small | Exact: overlap = Σ effective radii of enabled stages at render scale, computed per render (each stage registers `effective_radius(scale)`) |
| Large-kernel / global | clarity (40 px·scale), dehaze (dark-channel, global stats), §4.2 mask blur at native scale | **Proxy escape hatch:** compute the stage's low-frequency product (blur plane, transmission map) full-frame at proxy resolution, upsample into each tile. Dehaze already works exactly this way interactively (¼-res + bilinear); this generalizes the pattern. |

A tile render = exact-overlap small kernels on `(tile + overlap)` + sampled proxy planes
for large kernels + point ops. Overlap is computed, not guessed — switching clarity off
shrinks it; deep-denoise (§3.2) never affects it (input-referred, inside the decode).

**Gate to flip `deepZoomEnabled`:** ticket #11's parity test — tile-assembled output vs
whole-image render, ΔE budget at seams — green across the reference scene set with all
spatial sliders engaged. Same harness then covers web when web adopts tiles (the FFI/WASM
tile entries are shared; web follows Apple in a second step, after §5.1/§5.2).

**Payoff:** 100%-zoom refine on 100 MP goes from whole-image (~7 s observed on iPad) to
visible-viewport work (≈3–7 MP with overlap, >10× less), and pan-while-zoomed refines
incrementally by tile instead of re-rendering the world. Because the new `EditorView`
sits on the shared `EditSession`, the tile path serves the S5 editor directly — this is
what makes "zoom in and edit just that section" real in the new UI rather than a
slow-but-correct fallback.

## 6. Cross-cutting contracts

Every new slider/stage in this design carries the same checklist:

1. `ADJUSTMENT_SCHEMA` (Rust) entry → `tools/codegen.sh` → generated Swift/TS (CI drift
   gate). Ranges/defaults live only in Rust.
2. XMP: `papp:` namespace keys (`ChromaPrefilter`, `DeepDenoise`, `Brightness`), emitted
   only when non-default; writers in Swift + TS + Rust; byte-identical cross round-trip
   tests; docs/xmp-canonical-format.md table updated. Schema version bumped per
   docs/sidecar-schema.md rules; unknown-field passthrough untouched.
3. CPU reference in raw-core + WGSL in the unified wgpu pipeline (where the stage runs per
   tick); ≤4 storage buffers/stage; `test_color_pipeline.sh` + budgets ratchet in the same
   commit as any number movement.
4. Closed-form predictor + grey-card gates (`test_grey_adjustments.sh`,
   `test_synthetic_grey.sh`) — every stage above was chosen so the grey-card limit is
   closed-form (spatial terms degenerate to identity on uniform fields).
5. Apple verification with real fixtures via the UITest visual harness and slider-matrix
   harness (synthetic-only validation has burned Apple paths before — project memory).
6. No allocation in the render loop; no per-tick WASM round-trips (the decode-time/cached
   placement of §3 exists precisely to honor this).

## 7. Phasing and tickets

Ordered by user-visible value over effort; each phase is independently shippable and gets
its own GitHub issue(s) on the Files board (every PR closes a ticket):

| Phase | Scope | New tickets |
| --- | --- | --- |
| **1. Zoom in the new editor UI + web render parity** | §5.0 Apple: extract the FullImageView zoom host, wire EditorView off `pixelScale: 0`; §5.0/§5.2 web: pixelScale + pinch + gesture arbitration in `ImageCanvasComponent`; §5.1 sized decode + fast phase + viewport canvas | 3 (Apple editor zoom; web editor zoom; web render parity) — link the "fast phase deferred" follow-up noted in image-canvas.component.ts (#846 thread) and coordinate with the S4 loupe item under #577 |
| **2. Tone** | §4.1 brightness (full stack incl. predictor); §4.2 S/H rework + detail mask | 2 |
| **3. Noise** | §3.1 chroma pre-filter + default calibration; §3.2 BM3D (CPU, cached, progress UI) + patent review subtask | 2 |
| **4. Deep zoom** | §5.3 stage-class overlap + proxy planes; flip `deepZoomEnabled`; then web tiles | continues existing #11 (+1 for web adoption) |
| **5. Effects tools become real** | §10.0 multi-param pill model; §10.1 vignette; §10.2 grain; §10.3 split toning (closes the #643 placeholders) | 4 (pill model; one per tool) |
| **6. HSL** | §10.4 stage + 24 `crs:` fields + new slider-matrix cases; pill leaves `STUB_TOOLS` | 1 |
| **7. Crop & straighten** | §10.5 geometry stage + overlay UI + zoom/tile/vignette integration | 1–2 (pipeline; UI) |
| **8. Presets** | §10.7 storage + apply/save UI (no pipeline; can run in parallel with any phase) | 1 |

§10.6 hot/dead-pixel suppression rides with Phase 3 (it is tier 0 of the same noise
story and shares the calibration-sweep machinery).

Phase ordering rationale: 1 is UI wiring against render machinery that already ships
(the sized FFI exists; the new EditorView already sits on the zoom-aware
EditSession/CanvasMath) — highest UX-per-risk; 2 touches slider response and wants the
calibration harness time; 3 introduces new stages with cache/key changes; 4 has the
hardest correctness gate and benefits from §4.2's radius-registration work landing first.

## 8. Risks

- **Harness churn (Phases 2–3):** any default-on change moves every ΔE number. Mitigation:
  default-off first commits, calibration sweeps with numbers, budget ratchet in the same
  commit, per-case diffs before believing regressions (project memory).
- **Predictor debt:** main already has 14 failing grey predictors; the gate is "no new
  failures." S/H rework must update its predictors atomically.
- **BM3D determinism & cost:** atomic float aggregation is non-deterministic across thread
  counts; require fixed-point or ordered reduction (parity gate catches drift). Runtime is
  seconds — acceptable only because it is cached and committed-on-release.
- **AGPL/GPL contamination:** review rule — no constants/code from either repo; this spec
  is the implementation source.
- **Tile memory at native res:** proxy planes + per-tile buffers add footprint; bound by
  tile size (2048-class) and evict aggressively. Measured before un-gating.
- **Double-clean vs ACR refs (§3.1):** the calibration sweep is the mitigation; if neutral
  default isn't achievable, ship default 0 and revisit after a `nrColor` retune.

## 9. Alternatives considered (summary)

- **Chroma pre-filter in Oklab a/b** — rejected for decode-cost (cube-root round-trip,
  ticket #05's lesson); opponent channels give the same Y-passthrough guarantee linearly.
- **BM3D as an export/"enhance" tool writing new files** (RapidRAW's shape) — rejected:
  breaks sidecar-is-the-contract and forks edit history.
- **Brightness as RT-style gamma-space NURBS** — rejected: display-referred formulation
  sits awkwardly before AgX; the smoothstep-band gain matches Maple's existing scene-tone
  idiom and yields trivial predictors.
- **Guided-filter S/H mask (RT)** — deferred; see §4.2.
- **Fixed bigger tile overlap (e.g. 128 px) instead of stage-class system** — rejected:
  clarity's scaled radius (≈246 px @100 MP) breaks any constant; cost scales wrongly.
- **`crs:Brightness` for Lightroom interop** — rejected: PV2010 semantics mismatch.

## 10. Completing the new-UI editor: remaining tool designs

The S5 editor ships 22 tool pills; today `hsl`, `crop`, and `presets` are declared stubs
(`tool-model.ts STUB_TOOLS`), and the three Effects tools (vignette, grain, split tone)
write `papp:` fields that no pipeline stage reads (#643's staged placeholders). This
section makes every pill real. Each design inherits the §6 cross-cutting checklist
(schema→codegen→XMP ×3, CPU reference + WGSL, predictors, parity budgets, tile-class
registration) — only deltas are stated.

### 10.0 Tool-model placement (UI deltas)

- **Multi-param pills.** S5b's model is one drag bar for the armed tool. Tools below have
  2–24 parameters, so the tool model gains a **sub-parameter row**: arming a multi-param
  pill shows a compact selector above the drag bar (text chips for vignette/grain/split
  tone; 8 color dots + H/S/L toggle for HSL). The drag bar, chip overlay, fine mode, and
  haptics are unchanged — they act on the armed (tool, sub-param) pair. Single-param
  tools keep today's behavior exactly.
- **Light group gains Brightness** (§4.1) between Exposure and Highlights → 7 pills.
- **Noise pill becomes multi-param**: Luminance, Color (existing NLM), Deep (§3.2 BM3D),
  Prefilter (§3.1) — Detail group keeps 5 pills, no new glyph needed beyond sub-chips.
- Value-chip text shows the sub-param ("EFFECTS · VIGNETTE · FEATHER · 35").

### 10.1 Vignette (post-crop)

Scene-linear radial gain, anchored to the user crop rect (§10.5; DefaultCrop when none).
Late in the scene chain (after local adjustments, before capture sharpening), so AgX's
shoulder rolls the darkened/ lightened corners off filmically — the "highlight priority"
look falls out of the architecture instead of being a style option.

```
r    = normalized elliptical distance from crop center (aspect-matched ellipse)
m(r) = smoothstep(m0 − f·0.5, m0 + f·0.5, r)      // m0 = 0.7 fixed midpoint
gain = exp2(K · amount/100 · m(r))                 // K ≈ 1.5 EV at ±100, calibrated
```

`f` maps `vignetteFeather` 0–100 → transition width 0.05–0.9. Existing schema fields
(`papp:VignetteAmount`, `papp:VignetteFeather`) are kept as-is; midpoint/roundness are
schema extensions only if calibration shows they're needed, not shipped speculatively.
Predictor is position-aware: `predict_vignette(x, y, w, h, params)` exact closed form;
the synthetic-grey flatness invariant is explicitly waived for this stage and replaced by
center-identity + corner-attenuation assertions. GPU: point op given a tile-origin
uniform (tile-safe by construction). On a uniform grey card the center pixel is identity
— grey predictor cases pin the formula at sampled coordinates.

### 10.2 Film grain

Display-linear stage (post-AgX, before target gamut), because grain is a display-domain
aesthetic and scene-linear injection would make grain amplitude swing with exposure.
Luminance-modulated, monochromatic (luma-dominant like silver halide):

```
pitch  = lerp(1, 6, size/100) · longEdge/2000          // resolution-stable
n(x,y) = value-noise(hash2D(⌊x/pitch⌋, ⌊y/pitch⌋, SEED)), quintic-smoothed,
         + roughness/100 · second octave at 2× frequency, zero-mean
w(Yd)  = 4·Yd·(1−Yd) clamped                            // fades in deep blacks + near white
RGB'   = RGB + K · amount/100 · w(Yd) · n(x,y)          // same n on all channels
```

The hash is an integer PCG-style mix with identical constants in Rust and WGSL — fully
deterministic (fixed SEED; no RNG), so renders are reproducible and cross-platform
parity-exact. Coordinates are absolute image pixels → tile-safe and pan-stable. Gates:
mean-preservation on grey (zero-mean noise) plus a predicted standard deviation; preview
vs export parity across resolutions is **statistical, not pointwise** (grain re-samples
per resolution) — stated as the contract. Default 0 → no harness movement.

### 10.3 Split toning

Display-linear, in Oklab, ACR-compatible mental model. With `Yd` = display luminance,
balance `bal` ∈ [−100, +100]:

```
γ        = exp2(bal/100)                     // balance shifts the crossover
wS       = (1 − Yd)^γ · sS/100,  wH = Yd^(1/γ) · sH/100
(a, b)+  = K · [wS·(cos hS, sin hS) + wH·(cos hH, sin hH)]   // Oklab a/b shift; L unchanged
```

Existing five `papp:SplitTone*` fields; hues in degrees. Neutral-preserving at zero
saturations; L invariance keeps tone untouched. Predictor: exact Oklab (a,b) shift on
grey at known Yd. Point op in WGSL.

### 10.4 HSL (8-band hue/saturation/luminance)

New schema: the 24 ACR fields (`crs:HueAdjustmentRed…Magenta`,
`crs:SaturationAdjustment…`, `crs:LuminanceAdjustment…`, −100..+100, default 0) — `crs:`
namespace deliberately, for Lightroom interop. Scene-linear stage adjacent to the
existing vibrance/saturation block, computed in Oklab:

- Band weights: raised-cosine partition of unity over 8 hue centers aligned to ACR's
  bands, circular in hue angle.
- **Chroma gating:** weights scale by `smoothstep(0, C0, C)` so the neutral axis is
  exactly stable — hue is undefined at zero chroma, and this makes grey-card gates pass
  by construction.
- Hue slider rotates hue within the band (max rotation calibrated against ACR
  slider-matrix references), saturation scales C, luminance scales L (applied as a
  uniform RGB factor recovering the Oklab L change, hue-preserving).

Gates: new ACR slider-matrix cases (per-band XMPs rendered through the ACR reference
procedure in CLAUDE.md), budgets initialized by the standard new-case procedure. UI: the
`hsl` pill leaves `STUB_TOOLS`; sub-param row per §10.0. Targeted-adjust (drag on image
to edit the band under the cursor) is explicitly v2.

### 10.5 Crop & straighten

New schema: ACR-compatible `crs:CropTop/Left/Bottom/Right` (normalized), `crs:CropAngle`
(degrees, ±45), `crs:HasCrop`. Geometry stage at the end of the scene-linear chain,
before the view transform (matching the existing "AgX operates on the cropped frame"
ordering): inverse-transform sampling with rotation about the crop center — bilinear in
the fast phase, Lanczos on refine/export. Pipeline consequences, all designed in:

- `nativeImageSize` consumers (CanvasMath fit/zoom math, §5.0) switch to the **cropped,
  rotated extent**; the rendered-preview cache key already hashes adjustments, so crop
  changes invalidate correctly.
- Tiles: the geometry stage maps tile rects through the inverse transform with a 2 px
  sampling ring — registered with the §5.3 overlap calculator.
- Vignette (§10.1) anchors to this rect; thumbnails render post-crop.
- UI: the `crop` pill enters a canvas overlay mode — fit zoom forced, thirds grid, corner
  handles, aspect presets as sub-chips, and **the drag bar becomes the angle control**
  (±45°, fine mode for 0.1° — reusing S5b instead of inventing a rotation wheel).
  Predictors: geometry-only stage, exempt from tone predictors; correctness gated by
  round-trip tests (crop→render extent math) and an ACR interop fixture (LR-written crop
  XMP renders with the same framing).

### 10.6 Hot/dead-pixel suppression (tier 0 of the §3 noise story)

Pre-demosaic, raw-domain, as in RawTherapee's preprocess block: for each CFA site,
compare against same-color neighbors; flag `v > k·max(neighbors) + τ` (hot) or
`v < k'·min(neighbors)` (dead, stuck-low) and replace with the same-color neighborhood
median. Conservative thresholds; parameter `papp:HotPixelSuppression` (off/on, default
off until the §3.1-style harness sweep shows it's free on clean fixtures). Runs inside
the decode product — zero per-tick cost, invisible to predictors (identity on synthetic
grey by construction since the card has no impulses).

### 10.7 Presets

Pure product feature — no pipeline work. A preset is a named, schema-versioned **sparse
AdjustmentModel** (only non-default fields, same field names codegen already emits).

- **Storage:** Apple — JSON documents in Application Support (sync later); web — a
  `presets` collection in the existing API/Mongo layer, served through maple-common.
  Built-ins ship as bundled JSON (neutral utility set; no color-claim names).
- **Apply** = sparse merge into the current model → one undo-ring entry → normal
  debounced XMP save. **Save preset** captures current non-defaults. Unknown fields from
  newer schema versions are preserved on round-trip (same passthrough rule as XMP).
- UI: `presets` pill opens an S1c bottom sheet (phone) / popover (desktop) listing
  built-ins + user presets with apply/save/delete. Leaves `STUB_TOOLS`.

## 11. Ledger: larger absent features, deliberately not designed here

Listed so "missing" is complete; each needs its own spec/program:

- **Masking / local-adjustment UI** — the pipeline hook exists (`local_adjustments`,
  #280) but no authoring UI. Linear/radial gradients + luminance range mask is the
  Capture-One-grade core; AI subject masks (RapidRAW uses SAM-class models) are a
  separate research track.
- **Lens corrections** (distortion/CA/vignetting from a lens database) — needs a lensfun-
  class data source decision + a geometry stage; interacts with crop (§10.5) and tiles.
- **Panorama** — spec exists (`docs/tickets/04`); P3/P4 currently blocked upstream.
- **X-Trans premium demosaic** — Markesteijn shipped; an AMaZE-class upgrade is a
  raw-core-only project gated by the parity harness.
- **ICC output profiles** — four compiled matrices today; arbitrary ICC needs an LCMS2
  decision (binary size + parity implications on web/WASM).
- **Parametric tone region sliders** — fields exist (#273), no XMP/UI; superseded in
  priority by §4 but kept on the ledger.
- **White-balance picker (eyedropper)** — small, high-value; needs canvas hit-testing →
  scene-linear sample → temp/tint solve. Natural follow-up to §5.0's canvas work.
- **Engineering debt adjacent to this spec** (tracked, not features): Apple `nr_color`
  Gaussian-vs-NLM parity break; MSL removal (#1043); web fast-phase follow-up (#846).

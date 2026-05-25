# Auto Tone, and the Look dropdown (None / Maple Look / Auto)

Status: draft
Owner: zubair
Date: 2026-05-25
Builds on: the DisplayLookCurve work (#371) and the 4-tier DCP resolver (#397),
landing on `claude/serene-planck-LWvPn`. This spec assumes that branch's
`view::look::Look` enum, the parked `stages::auto_exposure`, and the
`papp:Look` XMP attribute are in `main`.

## Summary

Two adjacent — but deliberately _separate_ — features:

1. **Auto Tone** — a one-shot **button** that analyses the image and **writes
   slider values** (exposure, contrast, whites, blacks, highlights, shadows).
   The sliders visibly move; the result is an ordinary, fully-editable starting
   point persisted as normal slider values in the XMP. This is an _editing
   assist_.

2. **The Look dropdown** — a picker in the Develop panel with three options:
   - **Maple Look** (default) — the empirical 1D display LUT (`Look::Default`, #371).
   - **None** — strict scene-referred AgX, no shaping (`Look::Neutral`).
   - **Auto** — a **new** per-image _adaptive_ display curve that does **not**
     touch the sliders. It is a final tone-shaping layer recomputed every
     render; the user's sliders sit underneath it and stack with it. This is a
     _rendering mode_, not an edit.

The thing to hold onto: **Auto Tone moves sliders; the Auto Look never does.**
They can be used independently or together.

## Why this, why now

- New users (and cull/triage flows) want a single "make this a sensible
  starting point" action. Today every fresh-open image sits at model defaults
  and the user dials in exposure by hand.
- The histogram-shape auto-exposure engine is **already in the tree**, ported
  from RawTherapee's `getAutoExp`, sitting at `AE_DAMPING = 0.0` (identity)
  explicitly "as infrastructure for a future user-facing Auto toggle"
  (`src/raw-pipeline/raw-core/src/stages/auto_exposure.rs`). Feature 1 is
  largely _wiring up work that already exists_, plus a Maple-native slider
  mapping.
- `Look` already exists as a core/XMP concept (`Neutral`/`Default`) but has no
  UI and is invisible on the live canvas. Shipping the dropdown forces us to
  close the live-preview Look gap (see "The GPU preview gap" below), which is a
  standing #371 follow-up regardless.

## Terminology — the two "Autos" (read this twice)

|                   | **Auto Tone** (Feature 1)                                   | **Auto Look** (Feature 2)                                               |
| ----------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Surface           | A button ("Auto") near the tone sliders                     | One option in the Look dropdown                                         |
| What it changes   | The **slider values** in `AdjustmentModel`                  | Nothing in the model except `look = Auto`                               |
| Visible to user   | Sliders jump to new positions                               | Sliders unchanged; image is reshaped                                    |
| When it runs      | Once, on click                                              | Every render, adaptively                                                |
| Persisted as      | `crs:Exposure2012`, `crs:Contrast2012`, … (real slider XMP) | `papp:Look="Auto"` only                                                 |
| Editable after    | Yes — tweak any slider                                      | The _look_ is fixed-algorithm; you edit by moving sliders underneath it |
| Mental model      | "Suggest a good starting edit"                              | "Adaptively grade the final image; follow me as I edit"                 |
| Pipeline location | `scene_tone_controls` (mid-chain, scene-linear)             | `view::look` (final, display-encoded)                                   |

## What exists today (load-bearing context)

| Component                                                                | Status                            | Where                                                                |
| ------------------------------------------------------------------------ | --------------------------------- | -------------------------------------------------------------------- |
| Histogram-shape auto-exposure (RawTherapee `getAutoExp` port)            | Built, **parked at identity**     | `raw-core/src/stages/auto_exposure.rs`                               |
| `AutoExposure { expcomp, black, bright, contr, hlcompr, hlcomprthresh }` | Returned, currently discarded     | same file; called in `pipeline/develop.rs:281`                       |
| `Look { Neutral, Default }` enum                                         | Built                             | `raw-core/src/view/look.rs`                                          |
| Static empirical Look LUT (768 B, `derive_look_lut.py`)                  | Built                             | `raw-core/src/view/look_lut.rs`                                      |
| `papp:Look` XMP read/write (Rust + Swift + TS)                           | Built                             | `xmp.rs`, `AdjustmentModel.swift`, `xmp-serializer.service.ts`       |
| Look applied on **u8 export/CLI** path                                   | Built                             | `pipeline/render.rs:57,185,246`                                      |
| Look applied on **live GPU canvas**                                      | **Missing**                       | — (known #371 follow-up)                                             |
| Scene-linear slider closed-form predictors                               | Built                             | `src/scripts/test_grey_adjustments.sh`                               |
| Per-case perceptual harness vs ACR references                            | Built (CI gate)                   | `src/scripts/test_color_pipeline.sh`, `test-fixtures/budgets.json`   |
| Develop tab UI sections (Tone, WB, Presence, Sharpen, Noise)             | Built                             | `web .../components/editor-detail-panel/`, Swift `DetailPanel.swift` |
| `Look` selector UI (any platform)                                        | **Missing**                       | —                                                                    |
| Auto white balance algorithm (`WhiteBalancePreset::Auto`)                | Enum value only, **no algorithm** | `types/adjustment/mod.rs`                                            |

### The develop chain order (where each Auto lives)

```
decode → linearize → dcp → profile_gain_table_map → capture_sharpening
   → auto_exposure (identity today)            ← Auto Tone analyses HERE (scene-linear)
   → white_balance (temp/tint)
   → scene_tone_controls (exposure,contrast,highlights,shadows,whites,blacks)  ← Auto Tone WRITES these
   → tone_curves → vibrance → saturation → clarity → texture → dehaze
   → local_adjustments → sharpen → nr_luminance → nr_color
   → [VIEW TRANSFORM] AgX → Rec.2020→sRGB → encode → quantize_u8
   → look::apply  (Maple/None today; Auto Look inserts HERE)                   ← Auto Look runs HERE
```

### The GPU preview gap (must-read for Feature 2)

`view::look::apply` runs only on the **u8 output paths** (`quantize_u8` call
sites in `render.rs` + `maple-cli`). The live editor canvas does **not** use
those paths:

- **Web**: `render_bytes_scene_linear` returns _pre-AgX scene-linear_ fp16; the
  WebGL shaders (`agx-view-transform.ts` et al.) do AgX + Rec.2020→sRGB +
  encode on the GPU. The Look LUT is never applied there.
- **Apple**: `apply_scene_linear_chain` (FFI) runs WB→…→AgX in Rust per tick and
  returns _post-AgX display-linear_ fp16; Metal does sharpen/nr_color + the
  final encode. The Look LUT is never applied there either.

**Consequence:** today the live canvas shows _no_ Look (not even Maple Look) —
it only appears on export/thumbnail/CLI. The dropdown is meaningless until the
Look is applied live. Closing this gap is **Phase 0** of Feature 2 and benefits
the existing Maple Look too.

## Research: how the field does this

**Auto-tone, established approaches**

- **Histogram percentile stretch / "auto levels"** (Photoshop Auto Tone,
  RawTherapee `getAutoExp`, darktable basecurve auto): pick black/white clip
  points at a small clip-% (0.02–0.5%), set a gain that lands the mean/median
  near mid-grey, derive a contrast amount from histogram spread. Deterministic,
  pure math, explainable. **This is exactly the parked engine we already have.**
- **Expert-model / learned auto** (Adobe "Auto Settings" / Sensei, Apple Photos
  Auto Enhance): a model trained on thousands of expert edits emits exposure,
  contrast, highlights, shadows, whites, blacks, vibrance. Better results, not
  reproducible offline, heavy, and a poor fit for a deterministic
  parity-gated Rust core. Out of scope; we treat ACR Auto only as a _reference
  target_ for tuning, not a dependency.
- **Scene-referred targeting**: because Maple is scene-referred with an AgX view
  transform, "expose to mid-grey" means _scene-linear_ 0.18, not display 0.5.
  The parked engine already targets `MIDGRAY = 0.1842` linear and samples
  post-DCP scene-linear Rec.2020 — correct surface, correct target.

**Adaptive looks, established approaches**

- **Auto contrast / auto-matched tone curve** (RawTherapee "Auto-Matched Tone
  Curve", Photoshop Auto Contrast): build a per-image tone curve from the output
  histogram — anchor black/white points, apply a mild S-curve sized to the
  spread. Global, cheap, hue-safe if done on luma.
- **Local/adaptive contrast** (CLAHE, local tone mapping): stronger but
  expensive, can halo, and is hard to make per-tick-cheap on 100MP. Out of scope
  for v1; the Auto Look is a **global** adaptive curve (a follow-up can add
  locality, mirroring the #389 3D-LUT direction).

**Conclusion.** Both features are well-served by histogram-driven _global_ math
that already half-exists in the tree. We reuse the AE engine for Feature 1 and a
sibling histogram→curve builder for Feature 2. No ML, no new heavy deps.

---

## Feature 1 — Auto Tone (the button)

### Product behavior

- A single **"Auto"** control in the Develop panel's Tone section. One click
  analyses the current image and sets the tone sliders.
- The sliders **visibly move** to the computed values and are immediately
  editable. Auto is not a mode — it is a one-shot write.
- A second click (or an "Auto" that is already satisfied) is idempotent given
  the same upstream state. A "Reset tone" affordance returns the six fields to
  default.
- Auto respects (does not overwrite) WB unless the user opts into "Auto WB"
  (separate; see below). It only writes the six scene-tone fields.
- Works in Browse (apply to selection / batch) and Full-image (single).

### Which sliders, and the mapping

Maple's tone block is `exposure (EV)`, `contrast`, `highlights`, `shadows`,
`whites`, `blacks` (all −100..100 except exposure in EV). **Maple has no
"brightness" slider** — in a scene-referred model "brightness" _is_ exposure (a
linear multiply). We map the user's "brightness" intent onto `exposure`; we do
**not** introduce a brightness slider. (Decision flagged in Open Questions.)

Rather than translate RawTherapee's slider _units_ (its `bright`/`contr` are a
different curve from Maple's AgX-routed controls), we use a **Maple-native
inversion**: the AE engine gives us histogram _targets_; the existing
closed-form scene-linear slider predictors (`test_grey_adjustments.sh`) let us
**solve for the slider value that hits a target**.

| Maple slider | Target the auto solves for                           | Source signal                               |
| ------------ | ---------------------------------------------------- | ------------------------------------------- |
| `exposure`   | scene-linear luma median → AgX mid-grey (0.18)       | AE `expcomp1` (mean/median-to-midgrey gain) |
| `whites`     | highlight clip point at `clip_hi%` (≈0.1%) of pixels | AE `whiteclip` bin                          |
| `blacks`     | shadow clip point at `clip_lo%` (≈0.25%) of pixels   | AE `shc` bin                                |
| `contrast`   | histogram spread → S-curve amount                    | AE `ospread` (octile spread)                |
| `highlights` | recover clipped headroom (pull down if blown)        | AE `hlcompr`                                |
| `shadows`    | open crushed shadows (lift if needed)                | shadow-mass below `shc`                     |

The inversion (target → slider value) is fit **once**, offline, by sweeping each
slider through the closed-form predictor and storing a monotone lookup
(target-percentile → slider value). This keeps the auto values expressed in real
Maple slider units, so the user sees and can edit honest numbers.

### Phasing (Feature 1)

- **Phase 1a — exposure only.** Wire AE `expcomp` → `exposure`. This is the
  cleanest, best-defined mapping (EV↔EV, a linear multiply) and is immediately
  parity-testable. Ships the button with exposure-only behavior.
- **Phase 1b — whites + blacks.** Clip-point driven; calibrate `clip_hi/lo%`
  against ACR-Auto references in the existing harness.
- **Phase 1c — contrast + highlights + shadows.** Spread- and
  recovery-driven; needs the most calibration. Gate each addition on the
  perceptual harness (new `auto` cases per fixture).
- **(Related, separable) Auto WB.** Implement `WhiteBalancePreset::Auto` (e.g.
  robust gray-world / illuminant estimate in scene-linear) and optionally fold
  into the Auto button as a checkbox. Tracked as its own ticket; not blocking.

### Engineering

- **Where it computes.** A new shared raw-core entry analyses the **post-DCP,
  post-WB** scene-linear Rec.2020 buffer (so targets reflect the neutralised
  image the user sees). Reuse `auto_exposure::build_luma_histogram` +
  `compute_auto_exposure`, then run the target→slider inversion.

  ```rust
  // raw-core/src/stages/auto_tone.rs (new)
  pub struct AutoTone {
      pub exposure: f32, pub contrast: f32, pub whites: f32,
      pub blacks: f32, pub highlights: f32, pub shadows: f32,
  }
  pub fn compute_auto_tone(scene_post_wb: &Image, clip: f32) -> AutoTone;
  ```

- **FFI / WASM surface (parity-critical).** Expose `compute_auto_tone` so both
  front-ends call the _same_ implementation and get _identical_ values:
  - WASM: `maple_compute_auto_tone(scene_linear_fp16, w, h) -> AutoTone` (or
    accept a precomputed 8192-bin histogram to avoid re-walking pixels — the
    front-end already holds the scene-linear buffer).
  - FFI: `maple_compute_auto_tone(in_ptr, w, h, *out: MapleAutoTone) -> i32`.
    The front-end then writes the returned values into its `AdjustmentModel` and
    triggers one re-render. No new per-tick cost.

- **Performance.** One-shot. Run on the **already-downsampled preview buffer**
  (~2 MP), not full-res — an 8192-bin histogram over ~2 MP is well under a frame.
  No allocation in the render loop; this is off the slider-tick path entirely.

- **Persistence.** The six values serialize through the **existing** slider XMP
  attributes (`crs:Exposure2012`, `crs:Contrast2012`, …). No schema change.
  Auto leaves no marker — once applied, it is indistinguishable from a manual
  edit (by design; it _is_ an edit).

### UI (Feature 1)

- Web: an "Auto" button in `tone-section.component` header, beside a "Reset"
  affordance. Accessible label `tone-auto`.
- Apple: a button in the Tone group of `DetailPanel` Develop tab; accessibility
  identifier `tone-auto` (UITest harness can assert sliders moved).
- Batch: in Browse, "Auto" applies per-image (each image analysed on its own
  histogram), not a single shared correction.

---

## Feature 2 — the Look dropdown (None / Maple Look / Auto)

### Product behavior

- A dropdown at the **top of the Develop panel** (above Tone), labelled "Look":
  - **Maple Look** — `Look::Default`, the empirical LUT. The default.
  - **None** — `Look::Neutral`, strict scene-referred AgX.
  - **Auto** — `Look::Auto` (**new**), a per-image adaptive display curve.
- Changing the Look re-renders immediately. It **does not touch any slider**.
- With **Auto** selected, the user keeps editing with the sliders as normal; the
  Auto curve re-derives from the new result on each render and "follows" the
  edit. This is the user's quoted intent: _"a look that does not move the
  sliders — your sliders are applied on top of the image."_

### The Auto Look algorithm

A **global, hue-preserving, histogram-driven display curve** computed at render
time from the near-final image, in the **same domain** as the static Maple Look
(sRGB-encoded [0,1]):

1. Compute the output **luma** histogram of the post-AgX, post-encode image
   (luma to preserve hue by construction; per-channel is a future option for
   cast removal).
2. Build a 256-entry tone curve:
   - **Black/white anchors** at `clip_lo/hi%` percentiles (auto-levels).
   - **Mild S-curve** sized to histogram spread (more lift for flat/hazy scenes,
     less for already-contrasty ones) — capped to avoid over-cooking.
   - Optionally **compose with the Maple empirical shaping** so Auto reads as
     "Maple Look, adapted to this image" rather than a generic auto-contrast.
3. Emit a `[u8; 768]` (or float) **1D LUT**, applied exactly where
   `view::look::apply` applies today.

It is **deterministic** given the pixels, so parity holds across platforms. It
is monotone non-decreasing (same invariant the static LUT is tested for).

### Engineering — render-time data flow (no XMP for derived data)

The Auto LUT is **derived data** and must **not** be stored in XMP (same
invariant as the describe/vision work: no XMP for derived data). The model
stores only `look = Auto`. The LUT is computed every render:

```
render working-res image
  → compute luma histogram            (raw-core: cheap, reuse AE histogram)
  → build_auto_look_lut(hist, params) (raw-core: returns [u8;768] / floats)
  → apply LUT  (u8 path: look::apply_lut;  GPU path: upload LUT texture)
```

`view::look::apply` is extended from "enum → static LUT" to accept an optional
**runtime LUT**:

```rust
pub enum Look { Neutral, Default, Auto }          // + Auto
pub fn lut_for(look: Look, stats: Option<&ImageStats>) -> Option<[u8; 768]>;
// Neutral → None; Default → static LUT; Auto → build from stats.
```

### Phase 0 — close the GPU preview gap (prerequisite, also fixes Maple Look live)

Apply the Look as a **final 1D-LUT step in the GPU view transform on both
platforms**, sampled in sRGB-encoded [0,1] (the domain the static LUT was
derived in):

- **Web**: add a `uLookLUT` `sampler2D` (256×1 RGB texture) + `uLookMode` to the
  WebGL encode stage (`agx-view-transform.ts` final block, after Rec.2020→sRGB);
  per-channel texture lookup before `outColor`. Neutral → skip.
- **Apple**: apply the LUT in the Metal final-encode kernel (or a `CIColorCube`/
  `CIColorCurves` in the CoreImage encode), fed the same 256×3 table. The
  `MapleAdjustmentParams` FFI struct gains a `look_mode` flag and the chain hands
  the LUT bytes alongside (the static LUT for Default, the per-image LUT for
  Auto).

raw-core remains the **single source of LUT generation** (static + adaptive);
the GPUs only _sample_ an uploaded table. This guarantees live-canvas ==
export parity and keeps one implementation.

For **Auto**, the per-image LUT is uploaded each render. To stay in budget,
compute the histogram on the **working-resolution** buffer the render already
produced (viewport-res in the fast phase, full-res in the 150 ms refine phase) —
no extra full-res pass on the slider-tick path.

### Performance (Feature 2)

- **None / Maple Look**: one static LUT upload (or none); per-pixel cost is a
  single texture lookup in a shader stage that already runs. Negligible.
- **Auto**: one luma histogram over the working-res buffer + a 256-entry LUT
  build + the same per-pixel lookup. The histogram is the only added cost;
  on a ~2 MP viewport buffer it is sub-millisecond and fits the 16 ms tick. The
  full-res histogram runs only in the debounced refine phase.
- **Temporal stability**: because Auto re-derives as sliders move, the curve
  shifts continuously. That is deterministic-per-state and generally desirable,
  but can feel "alive" during a drag. Optional damping/anchoring (EMA across
  ticks, or freeze the LUT during an active drag and refit on release) is a
  tuning knob — default to refit-each-render, revisit if it shimmers.

### UI (Feature 2)

- Web: a `Look` `<select>` (or segmented control) at the top of
  `develop-tab.component.html`, above `editor-tone-section`. Bound to
  `model.look`. Accessibility label `develop-look`.
- Apple: a `Picker` at the top of the Develop tab in `DetailPanel.swift`,
  accessibility identifier `develop-look`.
- Copy: `Maple Look` / `None` / `Auto`. Tooltip on Auto: "Adaptive — grades each
  image automatically; your sliders apply on top."

---

## Interaction between the two features

Fully composable and well-ordered:

- **Auto Tone** writes slider values that feed `scene_tone_controls` mid-chain.
- **Auto Look** shapes the _final_ display output after the view transform.
- With both active: Auto Tone sets a sensible scene-linear edit, the develop
  chain renders it, then the Auto Look adaptively grades the encoded result. No
  conflict — they operate at different pipeline stages.
- Selecting Auto Look does **not** disable or move the (possibly auto-toned)
  sliders, and clicking Auto Tone does **not** change the Look selection.

## Cross-platform parity

- **Auto Tone**: `compute_auto_tone` lives in raw-core; Swift (FFI) and Web
  (WASM) call it. Identical inputs → identical slider values. A
  `maple-cli auto-tone <raw>` subcommand dumps the values for a golden test.
- **Auto Look**: `build_auto_look_lut` lives in raw-core; both GPUs sample the
  raw-core-produced table. A golden test pins the produced LUT bytes per fixture;
  the existing Rust↔GLSL byte-equality pattern (used for the AgX LUT) extends to
  the Look LUT texture.
- The `Look` enum already has a codegen mirror in Swift/TS; add the `Auto`
  variant to all three (`look.rs`, `AdjustmentModel.swift`,
  `adjustment-model.generated.ts`) and to the `papp:Look` parsers/serializers.

## Data model / XMP changes

- `papp:Look`: add `"Auto"` to the accepted values (Rust + Swift + TS read,
  write, and round-trip). `Default` stays the omitted/implied value; `Neutral`
  and `Auto` are written explicitly.
- **No** new XMP fields. Auto Tone reuses existing slider attributes; Auto Look
  stores only the enum. The adaptive LUT is derived data and is never persisted.
- `AdjustmentModel.look` widens from 2 to 3 variants. Defaults unchanged
  (`Default`). The parity-harness baseline is unaffected for existing fixtures
  (no fixture sets `look = Auto`).

## Testing

- **Auto Tone**: unit-test `compute_auto_tone` against synthetic histograms
  (flat, bimodal, clipped). Add per-fixture `auto` cases to
  `test-fixtures/references/manifest.json` rendered with Auto applied, gated in
  `budgets.json` (one-way ratchet). Cross-validate FFI/WASM values via the
  `maple-cli` golden. Swift UITest: assert the six slider identifiers change
  after tapping `tone-auto`.
- **Auto Look**: golden-pin `build_auto_look_lut` bytes per fixture; monotone +
  endpoint invariants (mirror the existing `look.rs` tests); Rust↔GLSL LUT
  byte-equality; add `look=Auto` perceptual cases with their own budgets.
- **Phase 0 (live Look)**: a parity test that the GPU-rendered canvas with
  `Look::Default` now matches the u8 export within budget (closing the
  preview/export divergence), via the XCUITest visual harness + the web
  WebGL parity spec.

## Out of scope (v1)

- Learned/ML auto (Adobe-Sensei-style). We only use ACR Auto as a tuning target.
- Local/adaptive-contrast Auto Look (CLAHE / 3D-LUT / context-aware) — that is
  the #389 direction; v1 Auto Look is a global hue-preserving curve.
- User-authored / importable custom Looks (LUT packs, `.cube`). The dropdown is
  fixed to three options in v1.
- Auto WB is specced as _related and separable_, not bundled into v1 of the Auto
  button (can land as a follow-up checkbox).

## Open questions / decisions needed

1. **Brightness slider?** Recommendation: **no** — map "brightness" intent to
   `exposure`. If product wants an independent midtone control, that's a new
   slider (or the parametric-curve midpoint), specced separately. Confirm.
2. **Auto Tone scope in v1**: ship exposure-only (Phase 1a) first, or hold the
   button until whites/blacks/contrast are calibrated (1b/1c)? Recommendation:
   ship 1a behind the same button and expand the mapping in place.
3. **Auto WB in the Auto button?** Separate control, or a checkbox on Auto?
   Recommendation: separate first; revisit bundling after it exists.
4. **Auto Look = pure auto-contrast, or auto-contrast ∘ Maple shaping?**
   Recommendation: compose with Maple shaping so "Auto" is recognisably Maple,
   not a generic levels stretch. Confirm.
5. **Auto Look temporal damping** during an active slider drag: refit-each-tick
   (simplest, most "correct") vs freeze-and-refit-on-release (calmer). Default to
   refit; flag if it shimmers in testing.
6. **Default Look stays `Maple Look`** for new users — confirmed unchanged.

## Issue breakdown (epic → tickets)

Epic: **Auto Tone + Look dropdown**.

Feature 1 — Auto Tone

- `core: auto_tone module + compute_auto_tone (exposure-only, Phase 1a)`
- `ffi/wasm: expose compute_auto_tone; maple-cli auto-tone subcommand + golden`
- `web/apple: "Auto" button in Tone section, slider write-back + re-render`
- `core: whites/blacks via clip-point inversion (Phase 1b) + harness cases`
- `core: contrast/highlights/shadows (Phase 1c) + harness cases`
- `(related) core: WhiteBalancePreset::Auto algorithm`

Feature 2 — Look dropdown

- `Phase 0a — web: apply Look LUT in WebGL encode (live Maple Look) + parity`
- `Phase 0b — apple: apply Look LUT in Metal/CoreImage encode (live Maple Look) + parity`
- `core: add Look::Auto + build_auto_look_lut + papp:Look="Auto" round-trip (Rust/Swift/TS)`
- `web/apple: Look dropdown UI (None / Maple Look / Auto)`
- `core+gpu: upload per-image Auto LUT each render (both platforms) + budgets`

Each PR closes its ticket; perceptual-harness budgets land in the same commit as
the improvement they measure.

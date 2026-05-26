# Auto Tone + Look dropdown — design spec

Status: draft
Owner: zubair
Date: 2026-05-26
Supersedes: `.archived-plans/specs/2026-05-25-auto-tone-and-looks-design.md` (written pre-#416 closure; outdated by Wave 3)
Builds on: `main` HEAD post-#416 epic closure (PRs #443, #487, #494, #500). All Wave 3 algorithm work is done; this design layers the user-facing "look" product on top.

## Summary

Three controls that together position Maple as a Lightroom alternative — finished-looking by default, with optional auto-correction and per-image adaptive grading:

1. **Static Maple Look** (`papp:Look = Default`) — the default. A 1D display LUT applied uniformly to every photo on all platforms (CPU export, Apple Metal canvas, Web WebGL canvas). Empirical LUT (ACR-regressed) in Phase 1; a designed AgX-log-domain shaper in Phase 2 (future).
2. **Auto Tone button** — a one-shot button in the Develop panel's Tone section. Analyses the image's histogram and writes the six tone slider values (exposure, contrast, highlights, shadows, whites, blacks). Sliders visibly move; user can edit any of them.
3. **Auto Look dropdown option** (`papp:Look = Auto`) — an adaptive per-image display curve built from the post-encode histogram every render. Composes with the static Maple Look's shape. Does not move sliders.

The first two ship together as the user-facing "Maple has a look" moment. Auto Look is a follow-up phase.

## Product position

Maple-as-Lightroom-alternative. First-open RAW renders with a Lightroom-familiar finished look. User can flip to "None" for scene-referred neutral if they want. Auto Tone gives a one-click sensible starting edit. Auto Look gives ongoing adaptive grading for users who prefer it.

The strategic decision from epic #416 was "AgX neutral is the look, stop chasing ACR." This design **partially reverses** that: Maple Look (the empirical LUT) closes the Lightroom-feel gap by default. The reversal is explicit, scoped, and time-boxed — Phase 2 of this spec will replace the empirical LUT with a Maple-original designed shape in AgX-log domain, but in the meantime, empirical-by-default is the right product position for the user we're targeting.

## What's in main (relevant context)

Wave 3 of #416 just closed. Pipeline state on main:

- AgX hue-restored ratio-preserving sigmoid (#435) — neutral, no creative shaping
- Oklab gamut compression (#435 + #438)
- 8×8 Bayer dithering before 8-bit quantize (#441)
- Hybrid mid-gray + p95 auto-exposure anchor (#429, #494) — automatic exposure normalization
- 4-tier `ProfileSource::{EmbeddedFull, BundleConfident, EmbeddedCmOnly, RawlerFallback}` (#460)
- CAT16 user WB (#431)
- f32 scene-buffer end-to-end on Rust + Apple chain + Web ping-pong (#482, #487)
- Default sharpening `sharpen_amount=40` (Lightroom-import-default per #326)

**Retired in Wave 3:**

- Empirical 1D Look LUT (#443). `view/look.rs`, `view/look_lut.rs`, `derive_look_lut.py` deleted.
- `Look` enum kept with `Neutral`/`Default` variants but **both are no-ops** post-#443.
- `papp:Look` XMP attribute still parses + round-trips (back-compat).

**Implications for this spec:**

- Phase 0 work (resurrecting the LUT) restores files we just removed. This is intentional; the strategic decision to remove the LUT entirely was correct only if we were also willing to ship a scene-referred-neutral product. We chose Lightroom-alternative instead.
- `Look::Default` (currently a no-op) becomes the static Maple Look again. `Look::Neutral` (currently a no-op) stays a no-op (= "None" in the UI dropdown).
- `Look::Auto` is a NEW variant we add.

## Architecture

### Pipeline placement

```
[INPUT] RAW
   ├─ decode → linearize → dcp → profile_gain_table_map → capture_sharpening
   ├─ auto_exposure (mid-gray anchor + hybrid p95 — already in main)
   ├─ white_balance (CAT16)
   ├─ scene_tone_controls        ← Auto Tone writes these slider values
   │   (exposure, contrast, highlights, shadows, whites, blacks)
   ├─ tone_curves → vibrance → saturation → clarity → texture → dehaze
   ├─ local_adjustments → sharpen → nr_luminance → nr_color
   ├─ [VIEW TRANSFORM]
   │      AgX → Rec.2020→sRGB gamut compress → sRGB gamma + dither → 8-bit RGBA
   └─ look::apply               ← static Maple Look + Auto Look attach here
            │
            ├─ Look::None     → no-op (= AgX-neutral output)
            ├─ Look::Default  → static empirical LUT (Phase 1)
            └─ Look::Auto     → per-image LUT built from output histogram (Phase 3)
[OUTPUT] 8-bit sRGB
```

### Component responsibilities

**`raw-core/src/view/look.rs`** (resurrect from git history):
- Defines `Look` enum, `apply_lut(buf, lut)`, `lut_for(look, stats)`.
- `lut_for` returns:
  - `Look::None` → `None`
  - `Look::Default` → the static empirical LUT (constant data in `view/look_lut.rs`)
  - `Look::Auto` → the LUT returned by `view/auto_look.rs::build_auto_look_lut(stats)`

**`raw-core/src/view/look_lut.rs`** (resurrect from git history): the static 768-byte empirical LUT data. Re-extracted from the pre-#443 commit (see PR #493 reverse).

**`raw-core/src/view/auto_look.rs`** (new, Phase 3): builds a per-image 1D LUT from output histogram.

**`raw-core/src/stages/auto_tone.rs`** (new, Phase 1):
- `compute_auto_tone(scene_post_wb: &Image, clip: f32) -> AutoTone` — runs on **post-WB scene-linear** buffer so targets reflect what the user sees.
- Returns six slider values: `exposure, contrast, whites, blacks, highlights, shadows`.
- Reuses existing `auto_exposure::build_luma_histogram` (the histogram engine, not the gain heuristic).
- Inversion: for each slider, run the closed-form predictor sweep once at build time to produce a monotone lookup table (target percentile → slider value). At runtime, just look up the target percentile from the histogram and read off the slider value.

**Cross-platform LUT generation lives in raw-core only.** GPUs sample LUTs that raw-core produces. Guarantees Rust ↔ Metal ↔ GLSL byte parity.

### FFI / WASM surface

Two new entries:

```c
// LUT generation (called once per render to seed the GPU LUT texture)
int32_t maple_compute_look_lut(
    int32_t look_mode,         // 0 = None, 1 = Default, 2 = Auto
    const uint8_t* histogram,  // 8192-bin output histogram (NULL for non-Auto modes)
    uint8_t* lut_out_768       // [u8; 768] — match pre-#443 layout (see git history of view/look_lut.rs)
);

// Auto Tone (one-shot)
typedef struct {
    float exposure;
    float contrast;
    float whites;
    float blacks;
    float highlights;
    float shadows;
} MapleAutoTone;

int32_t maple_compute_auto_tone(
    const float* scene_post_wb_rgba,  // f32 scene-linear post-WB
    uint32_t width,
    uint32_t height,
    MapleAutoTone* out
);
```

Both are additive; existing FFI surface unchanged. Both consumed identically by Apple FFI and Web WASM, ensuring identical user-facing values.

### XMP changes

`papp:Look` already exists with two accepted values (`"Neutral"`, `"Default"`). Extend with a new variant:

- XMP `"Neutral"` → `Look::Neutral` — UI dropdown label: **"None"** (no look applied)
- XMP `"Default"` → `Look::Default` — UI dropdown label: **"Maple Look"** (the static empirical LUT, restored from pre-#443)
- XMP `"Auto"` → `Look::Auto` — **NEW** — UI dropdown label: **"Auto"** (adaptive per-image LUT)

UI labels intentionally differ from XMP string values for user-facing clarity ("None" reads better than "Neutral" in a dropdown). The internal name and serialized form stay `Neutral` for sidecar back-compat.

Read/write round-trip in Rust + Swift + TS. No schema version bump (additive variant per the `papp:Look`/`papp:ToneCurveMode` precedent — see KTLO #458's verification).

Auto Tone outputs serialize through the **existing** slider XMP attributes (`crs:Exposure2012`, `crs:Contrast2012`, etc.) — same as a manual edit. Auto Tone leaves no marker; once applied, it's indistinguishable from a hand edit (by design).

## UI surface

Two new controls in the Develop panel:

### 1. Look dropdown (top of Develop tab)

Position: above the Tone section.
Bound to: `model.look` (the `Look` enum field).
Options: `Maple Look` (= `Default`), `None` (= `Neutral`), `Auto`.
Default: `Maple Look`.
Behavior: changing it triggers a re-render but does not move sliders.

Tooltip on "Auto": *"Adaptive — grades each image automatically; your sliders apply on top."*

Accessibility identifier: `develop-look`.

### 2. Auto button (Tone section header)

Position: in the Tone section header, alongside Reset.
Behavior: one click → Maple calls `compute_auto_tone` → six slider values jump to computed positions. User edits any slider as normal afterward.
Idempotent: clicking Auto twice on the same input produces the same values.

Accessibility identifier: `tone-auto`.

### Two distinct "Autos" — the user mental model

| | "Auto" button (Tone section) | "Auto" option (Look dropdown) |
|---|---|---|
| Surface | Button in Tone section header | Item in Look dropdown |
| What it changes | The six slider values in `AdjustmentModel` | Nothing in the model except `look = Auto` |
| Visible to user | Sliders jump to new positions | Sliders unchanged; image is reshaped |
| When it runs | Once, on click | Every render, adaptively |
| Persisted as | `crs:Exposure2012`, `crs:Contrast2012`, etc. | `papp:Look="Auto"` only |
| Mental model | "Suggest a good starting edit" | "Adaptively grade the final image; follow my edits" |

### Batch (Browse mode)

- "Apply Auto Tone to selection" — per-image analysis (each photo independently).
- "Set Look = X" — uniform across selection.

### Default state for new sidecars

- `look = Default` (Maple Look), omitted from XMP (= default value).
- No Auto Tone applied (sliders at `AdjustmentModel::default()` — including `sharpen_amount = 40`).

## Phasing (Approach B — two parallel tracks)

### Track 1 — Maple Look on all platforms (Phase 0)

| Sub-task | What | Effort |
|---|---|---|
| 1a | Resurrect `view/look.rs` + `view/look_lut.rs` from git history (pre-#443 state) | small |
| 1b | Apply LUT in `pipeline/render.rs` (CPU/CLI) | small (call site existed before #443) |
| 1c | Wire LUT bytes through FFI (`MapleAdjustmentParams` gains `look_mode + look_lut_bytes`) | medium |
| 1d | Apple Metal: add `LookCube`-style filter in the final encode pass; consume FFI LUT | medium |
| 1e | Web WebGL: add `uLookLUT sampler2D` in `agx-view-transform.ts` encode stage | medium |
| 1f | Parity gate: Rust ↔ Apple ↔ Web byte-equality on a fixture set with `Look = Default` | small |

### Track 2 — Auto Tone (Feature 1, Phase 1a — exposure only)

| Sub-task | What | Effort |
|---|---|---|
| 2a | `stages/auto_tone.rs`: histogram analysis + target→slider inversion (exposure only) | medium |
| 2b | FFI + WASM surface: `maple_compute_auto_tone` | small |
| 2c | `maple-cli auto-tone` subcommand + golden test (cross-platform identical values) | small |
| 2d | Web UI: "Auto" button in `tone-section.component` | small |
| 2e | Apple UI: "Auto" button in `DetailPanel` Tone group | small |
| 2f | Per-fixture `auto_tone` cases in `test_color_pipeline.sh` manifest + budgets | medium |

Tracks 1 and 2 do not conflict (different files). They run in parallel.

### Converge — Phase 2 (Look dropdown UI)

After both tracks land:

| Sub-task | What | Effort |
|---|---|---|
| 3a | Extend `Look` enum to `{Neutral, Default, Auto}` in Rust + Swift + TS (codegen) | small |
| 3b | XMP read/write for `papp:Look="Auto"` (round-trip test) | small |
| 3c | Web UI: `develop-look` dropdown in `develop-tab.component` | small |
| 3d | Apple UI: `develop-look` Picker at top of DetailPanel | small |

### Phase 3 — Auto Look (adaptive)

| Sub-task | What | Effort |
|---|---|---|
| 4a | `view/auto_look.rs`: histogram → per-image LUT builder | medium |
| 4b | Compose with static Maple shaping (so "Auto" reads as "Maple Look, adapted to this image") | small |
| 4c | GPU pipelines upload per-image LUT each tick (working-res histogram only) | medium |
| 4d | Temporal stability tuning (refit each tick vs anchor during drag) | small |

### Phase 1b/1c — Auto Tone expansion (post-Phase-3)

- Phase 1b: whites + blacks via clip-point inversion.
- Phase 1c: contrast + highlights + shadows via spread/recovery inversion.
- Calibrated against ACR-Auto references in the harness, gated as new perceptual cases.

### Related-and-separable: Auto WB

Implement `WhiteBalancePreset::Auto` (e.g. robust gray-world / illuminant estimate in scene-linear). Not bundled with this v1; tracked as its own ticket.

## Testing strategy

### Parity gates (CI)

- **Rust ↔ GLSL byte equality on the Look LUT texture.** Extends the existing AgX-LUT parity test pattern.
- **Rust ↔ Swift FFI:** `maple_compute_auto_tone` returns identical values on the same input. Golden test.
- **`maple-cli auto-tone <raw>` golden:** per-fixture exposure value pinned (and the other five sliders, as 1b/1c ship).

### Perceptual harness

New cases per fixture in `test-fixtures/references/<n>/`:

- `look_none.png` — `papp:Look="None"`
- `look_default.png` — `papp:Look="Default"` (= the new static Maple Look on all platforms)
- `look_auto.png` — `papp:Look="Auto"` (Phase 3)
- `auto_tone.png` — after Auto Tone is applied (Phase 1a renders this with computed exposure value; 1b/1c extend)

ACR-rendered references for the first three (one-time reference generation against the post-Wave-3 pipeline output). Budgets land in the same commit as each new case (one-way ratchet rule).

### Unit tests

- `compute_auto_tone` against synthetic histograms (flat, bimodal, clipped).
- `build_auto_look_lut` against synthetic histograms; monotone + endpoint invariants (mirror existing `look.rs` test patterns).
- Resurrected `look::apply_lut` tests from pre-#443 history.

### Cross-cutting

- **Budgets:** every new perceptual case lands with its budget in the same commit. The closing-step PR #500 reset the baseline budgets; from this design forward, the one-way ratchet rule is in force.
- **Sidecar continuity:** existing XMPs (no `papp:Look`) render with `Look = Default` automatically. No migration needed.
- **Performance budget:** Auto Look adds ~0.5–1ms (histogram on working-res buffer + 256-entry LUT build) on slider-tick path; well under the 16ms target. Histogram on full-res buffer runs only in the 150ms debounced refine phase.

## Out of scope (v1)

- ML / Sensei-style learned Auto Tone (deterministic histogram math only).
- Local / CLAHE adaptive contrast in Auto Look (global curve only). Future direction: see the parked #389 3D-LUT work.
- Custom / user-imported LUTs (no `.cube` import). Dropdown stays at three fixed options.
- Maple Look v2 — the designed-in-AgX-log-domain replacement for the empirical LUT. Tracked as a separate effort post-this-spec.
- Auto WB. Specced as related and separable; not bundled into v1 of the Auto Tone button.

## Open questions

1. **Brightness slider?** Recommendation: **no** — map "brightness" intent to `exposure`. Confirmed in original spec; preserved here.
2. **Auto Tone v1 scope:** ship exposure-only (Phase 1a) first; expand the mapping in place (1b/1c). Confirmed.
3. **Default Look:** `Maple Look` (= `Default`) for new users. Confirmed.
4. **Auto Look composition:** compose with Maple shaping (so "Auto" reads as Maple-flavored, not generic levels). Confirmed.
5. **Auto Look temporal damping during slider drag:** default to refit-each-tick; revisit if it shimmers visibly. Confirmed.

## Issue breakdown (epic → tickets)

Epic: **Maple Look + Auto Tone + Look dropdown**.

Phase 0 — Maple Look on all platforms:

- `core: resurrect view/look.rs + view/look_lut.rs from git history`
- `core+cli: apply Look in pipeline/render.rs (CPU/CLI)`
- `ffi: add look_mode + look_lut_bytes to MapleAdjustmentParams`
- `apple: LookCube filter in Metal final-encode pass`
- `web: uLookLUT sampler2D in agx-view-transform.ts encode stage`
- `test: Rust ↔ Apple ↔ Web byte-equality parity gate on Look = Default fixtures`

Phase 1a — Auto Tone (exposure only):

- `core: stages/auto_tone.rs + compute_auto_tone (exposure-only)`
- `ffi+wasm: expose compute_auto_tone; maple-cli auto-tone subcommand + golden`
- `web+apple: "Auto" button in Tone section + slider write-back + re-render`
- `harness: per-fixture auto_tone cases + budgets`

Phase 2 — Look dropdown UI:

- `core: extend Look enum to {Neutral, Default, Auto}; codegen mirrors`
- `xmp: papp:Look="Auto" read/write/round-trip (Rust+Swift+TS)`
- `web+apple: Look dropdown UI`

Phase 3 — Auto Look (adaptive):

- `core: view/auto_look.rs + build_auto_look_lut + Maple-shaping composition`
- `gpu: per-image Auto LUT upload each render (web+apple) + budgets`
- `harness: per-fixture look_auto cases + budgets`

Phase 1b/1c — Auto Tone expansion (whites/blacks then contrast/highlights/shadows):

- `core: whites/blacks via clip-point inversion + harness cases (1b)`
- `core: contrast/highlights/shadows via spread/recovery inversion + harness cases (1c)`

Related-and-separable: Auto WB:

- `core: WhiteBalancePreset::Auto algorithm`

Each PR closes its ticket. Perceptual-harness budgets land in the same commit as the improvement they measure.

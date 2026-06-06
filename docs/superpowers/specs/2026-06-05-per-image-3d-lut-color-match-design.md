# Per-Image 3D LUT Color Match — Design

**Date:** 2026-06-05
**Status:** Approved architecture (3D LUT); spec for review.

## Context

Maple's per-image color match toward the camera's **embedded JPEG** is currently two stages:
- a **pre-AgX chroma grid** keyed on `(hue, Cr = C/L)` (`view/auto_profile/chroma.rs`), and
- the **#550 post-AgX per-channel tone curve** (`view/auto_profile`, applied in display sRGB).

The chroma grid produces **magenta banding / oil-slick blotch** in smooth gradients (confirmed on
test_0003: clean at k=0, banded at k=1.0). Root cause, established this session: it keys the
correction on **unstable derived coordinates** — `hue = atan2(b, a)` detonates on noise near the
neutral axis, and `Cr = C/L` is noisy at low L — and applies it **per-pixel**, amplifying RAW
noise/texture into spatially-incoherent color shifts. Neither lowering strength nor reweighting the
TPS solve removes it, because the fragility is the coordinate choice, not the magnitude. The grid is
**also a net ΔE regression** vs the #550 curve (aggregate 9.72 vs 8.81 across 15 fixtures).

The fix is to key the correction on **stable RGB values** via a smooth **3D RGB→RGB LUT** — the
general, robust form of the #550 per-channel curve, and the same kind of object as a DCP HueSatMap.
A value-keyed, smooth, locally-fit LUT is **blotch-free by construction**.

## Goal

Replace the chroma grid **and** the #550 per-channel curve with a single robust **per-image 3D
RGB→RGB LUT** fit from the embedded JPEG: blotch-free, at least matching #550's ΔE, and able to do
selective per-hue/sat correction the per-channel curve can't.

## Architecture

Pillars unchanged: **DCP** = deterministic color base; **AgX** = base tone; the **per-image LUT** =
display-space residual toward this frame's JPEG (the JPG pillar).

Render path (`Profile::Auto`), display tail:
```
… develop (DCP + sliders) → AgX → rec2020→sRGB → sRGB gamma encode
   → [NEW] per-image 3D LUT (trilinear)   ← replaces #550 apply_curve here
   → look → dither
```
- **Remove** the pre-AgX `chroma_match` stage (the grid) from the render path.
- **Replace** the `#550` `apply_curve` call with the LUT apply (the LUT subsumes the per-channel curve).
- **AE stays Off** when the LUT is active — the LUT owns the display-space mapping including
  brightness, exactly as #550 did (the proven behavior; avoids the un-anchored-dark confound).

## The LUT

- **Space:** display-encoded sRGB `[0,1]³` — the buffer state right where #550 fits/applies, and the
  space the embedded JPEG occupies after decode (`/255`). No new color conversions.
- **Representation:** **17³** RGB→RGB grid (`Vec<[f32;3]>`, len 4913), **trilinear** interpolation.
  17³ balances smoothness vs. detail for an 8-bit JPEG target; cheap to bake to a GPU 3D texture later.
- **Fit (robust, local, no global overshoot):**
  1. Sample `(maple_display_rgb, jpeg_display_rgb)` pairs — **reuse #550's display-space sampling**:
     downsample both to a small grid, pair by location, drop clipped / high-variance (edge) cells.
  2. Initialize every node to **identity**: `L[n] = p_n` (its own grid RGB).
  3. Per node `n` at position `p_n`: confidence-weighted **local** delta —
     `w_i = exp(-‖maple_i − p_n‖² / 2σ²)`, `Δ_n = Σ w_i (jpeg_i − maple_i) / Σ w_i`,
     confidence `c_n = Σw_i / (Σw_i + λ)`, then `L[n] = p_n + c_n · Δ_n`. Sparse nodes → `c_n → 0` →
     stay identity.
  4. **Smooth** the delta grid with a small separable 3D Gaussian (coherence + fills thin gaps).
  5. **Clamp** `L[n]` to `[0,1]`.
  - Global **strength `k`** (default 1.0, env-overridable for tuning) blends `L` toward identity.
- **Apply:** per-pixel **trilinear** lookup of `L` at the pixel's display RGB (in place, parallel).
- **Why it can't blotch:** RGB-value-keyed (no `atan2`, no `÷L`) + locally-supported regularized fit
  (no biharmonic/TPS global overshoot) + grid-smoothed + identity fallback + trilinear interp. Two
  pixels with the same RGB get the same output; nearby RGBs get nearby outputs.

## Reuse

- #550's embedded-JPEG decode + display-space pair sampling (whatever `fit_curve_from_*_display`
  uses) — the LUT fit consumes the same pairs, just bakes a 3D grid instead of 3 per-channel curves.
- The `auto_profile::cache` LRU — cache the baked LUT exactly as the curve was cached (same key).
- The LUT is a natural 3D texture for the Metal/WebGL paths (`bake_profile_lut` lineage), unlike the
  per-pixel grid — a strict improvement for GPU parity (follow-up, not this spec).

## Testing / Verification

- **Blotch (primary):** region local-std of the chroma contribution `(k=1 − k=0)` on test_0003
  forearm/sky/trees → near-zero (vs the grid's 6.3/9.0/8.4). The RGB-keyed smooth LUT must not
  oil-slick. Visual ×6 amplified diff confirms.
- **Accuracy:** ΔE2000 vs the **embedded JPEG** (the per-image target) and vs **ACR** (the gate)
  across the fixture set; must **≥ match #550** (aggregate ~8.81 vs ACR) and not regress per-fixture.
- **No Neutral regression:** `src/scripts/test_color_pipeline.sh` (chroma path isn't gated, Neutral is).
- **Unit tests:** identity LUT = exact no-op; all-sparse fit = identity; trilinear interpolation
  correctness; a synthetic pair set recovers a known shift; gamut clamp; cache round-trip.

## Risks

- **Overfitting the JPEG's tone** (drifting from ACR): bounded by regularization toward identity, the
  coarse 17³ grid, and the strength knob; gated by the ΔE-vs-ACR must-not-regress check.
- **test_0000 (DJI) outlier:** #550 blows up there (+10.8 vs Neutral); the LUT inherits the same
  JPEG-target risk. Verify the regularization tames it; if not, it's a separable follow-up (same
  status as today).
- **8-bit JPEG quantization / camera NR-sharpen baked into the target:** averaged out by clustering
  the pairs + grid smoothing.

## Out of scope

- Spatial/lens alignment of the RAW↔JPEG sampling (pre-existing "Gap 2") — the LUT uses the same
  sampling as #550, so it's neither better nor worse here.
- GPU (Metal/WebGL) wiring of the LUT — CPU reference lands first; the 3D-texture port is a follow-up.
- Removing the now-dead `chroma.rs` TPS code — the render path stops calling it in this work; a
  tidy-up deletion can follow once the LUT is proven.

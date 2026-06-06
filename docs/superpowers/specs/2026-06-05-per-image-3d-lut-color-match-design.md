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

Replace the chroma grid with a robust **per-image 3D RGB→RGB residual LUT** fit from the embedded
JPEG, **layered on top of the #550 per-channel curve** (not replacing it): blotch-free, at least
matching #550's ΔE by construction (`strength = 0` ⇒ identity residual ⇒ pure #550), and recovering
the value-keyed cross-channel correction the separable curve can't.

> **Update (2026-06-06): layer, not replace.** Baking #550's curve into the LUT grid is not exact
> (trilinear readback of the steep shadow curve costs 0.5–1.5 ΔE2000 where the gate is most
> sensitive), so #550 — its accuracy floor and gate — could dip *below* itself. Instead the render
> keeps #550's exact `apply_curve` and applies the LUT **after** it, fit on the already-curved buffer
> so the pairs are `(curve(maple), jpeg)`. A per-channel curve is the diagonal of a 3D LUT, so this
> **generalizes** #550 — the LUT carries only the cross-channel residual — and `fit_display.rs` stays
> load-bearing (do not delete it; only the chroma grid is retired).

## Architecture

Pillars unchanged: **DCP** = deterministic color base; **AgX** = base tone; the **#550 curve + the
per-image residual LUT** = display-space correction toward this frame's JPEG (the JPG pillar).

Render path (`Profile::Auto`), display tail:
```
… develop (DCP + sliders) → AgX → rec2020→sRGB → sRGB gamma encode
   → #550 apply_curve (exact, separable tone+brightness)
   → [NEW] per-image residual 3D LUT (trilinear, fit on the curved buffer)
   → look → dither
```
- **Remove** the pre-AgX `chroma_match` stage (the grid) from the render path.
- **Keep** the `#550` `apply_curve` call; **add** the residual LUT apply immediately after it, fit on
  the post-curve buffer so it keys on stable post-curve RGB and carries only the residual.
- **AE stays Off** when the curve fits — the #550 curve owns the display-space brightness mapping,
  exactly as before (the proven behavior; avoids the un-anchored-dark confound). The residual LUT
  never owns brightness, so disabling it does not flip AE back on.

## The LUT

- **Space:** display-encoded sRGB `[0,1]³` — the buffer state right where #550 fits/applies, and the
  space the embedded JPEG occupies after decode (`/255`). No new color conversions.
- **Representation:** Nᶟ RGB→RGB grid (`Vec<f32>`, layout `((b·N+g)·N+r)·3+c`), **trilinear**
  interpolation. Grid **SIZE is the single fidelity knob**; cheap to bake to a GPU 3D texture later.
- **Fit — hard-binning (`fit_lut_from_pairs`), the O(pixels) form:**
  1. Sample `(curve(maple)_display_rgb, jpeg_display_rgb)` pairs (`pairs::sample_display_pairs`,
     reusing #550's exact orient/aspect-crop/border geometry + the shared JPEG decode). Because the
     LUT runs after `apply_curve`, the render hands it the already-curved buffer, so `maple` is the
     post-curve value — no explicit transform.
  2. **Hard-bin** every pair into its nearest grid cell over ALL pairs (no subsample): accumulate
     `(jpeg − maple)` and a count per cell (Rayon fold/reduce ⇒ ~40ms even on a 100MP source).
  3. Per cell: confidence-weighted mean residual `Δ_c = (count/(count+λ)) · mean(jpeg − maple)`,
     `λ = FIT_CONF_COUNT`. Sparse cells → confidence → 0 → identity.
  4. **Confidence-masked** separable 1-2-1 smooth of the delta grid: empty cells stay at identity and
     are excluded from neighbours' blends (renormalised), so a populated cell on the colour-volume
     boundary isn't dragged toward identity by the empty cells outside the gamut. Trilinear fills
     empty interior cells at apply time.
  5. Compose `L[n] = p_n + strength · Δ_n`, **clamp** to `[0,1]`.
  - Global **strength `k`** (default 1.0): `k = 0` ⇒ identity residual ⇒ **exactly the #550 curve**.
- **Why hard-binning, not a Gaussian RBF:** at the σ a fidelity sweep drove the RBF to, the kernel had
  already collapsed to nearest-cell (`exp(−4.9)≈0.008` one node away) — but the RBF paid O(nodes×pairs)
  (30–60s, 30–60× over the cold-open budget) and its wide default σ washed out the value-keyed signal.
  Hard-binning is the same limit computed in one O(pixels) pass, and an oracle per-cell LUT confirmed
  ~48% of the #550→JPEG gap is genuinely value-keyed and recoverable (the RBF was leaving it on the floor).
- **Apply:** per-pixel **trilinear** lookup of `L` at the pixel's display RGB (in place, parallel).
- **Why it can't blotch:** RGB-value-keyed (no `atan2`, no `÷L`) + per-cell confidence-damped +
  masked-smoothed + identity fallback + trilinear interp. Two pixels with the same RGB get the same
  output; nearby RGBs get nearby outputs (test_0003 residual local-std 0.6 vs the grid's 6–9).

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

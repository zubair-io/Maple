use crate::{
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_plane,
    xmp::AdjustmentModel,
};

pub(crate) const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

pub(crate) fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Brightness midtone-band constants (#1102, tone/zoom design spec § 4.1).
/// The band weight is `smoothstep(B_LO0, B_LO1, Y) · (1 − smoothstep(B_HI0,
/// B_HI1, Y))`: exactly 0 at `Y ≤ 0.05` (blacks/shadows territory) and at
/// `Y ≥ 4.0` (scene ref-max — exposure/highlights territory), C¹-smooth in
/// between. `B_STRENGTH` maps slider ±100 to ±0.7 EV of peak midtone gain.
/// Initial values calibrated against the slider-matrix harness; the gate is
/// "monotone, midtone-pivoted, ends pinned" (no ACR counterpart exists for
/// this `papp:` slider).
const B_LO0: f32 = 0.05;
const B_LO1: f32 = 0.25;
const B_HI0: f32 = 1.0;
const B_HI1: f32 = 4.0;
const B_STRENGTH: f32 = 0.7;

// ----------------------------------------------------------------------
// Shadows / highlights rework constants (#1103, tone/zoom design § 4.2).
// All marked "calibrated" in the spec — initial values tuned against the
// slider-matrix harness; ratchet as the pipeline tightens.
// ----------------------------------------------------------------------

/// Shadows engagement ceiling: the weight is `(1 − smoothstep(0, S_T1, Y))²`,
/// exactly 0 at `Y ≥ S_T1`. Was 0.1 pre-#1103 — widened so the slider reaches
/// real shadow tones instead of only near-black.
pub(crate) const S_T1: f32 = 0.25;
/// Shadows gain cap in EV at slider ±100: `exp2(±S_GAIN_EV)` → 2.83× lift /
/// 0.35× crush at the deepest tones, fading to exactly 1 at `Y ≥ S_T1`.
///
/// MONOTONICITY BOUND (why this is 1.5, not the spec's "≈4×" initial value):
/// with the mix-form multiplier the per-pixel response is
/// `out(Y) = Y · (1 + (exp2(K) − 1) · w_s(Y))`; its derivative goes negative
/// once `(exp2(K) − 1) · max|w_s + Y·w_s'| > 1`. For the squared (0, T_s)
/// smoothstep falloff `max|w_s + Y·w_s'| ≈ 0.514` (at Y ≈ 0.55·T_s,
/// independent of T_s), so any cap above ~2.95× INVERTS tone ordering around
/// Y ≈ T_s/2 — at 4× a Y=0.10 pixel lands ~10 % brighter than a Y=0.15 pixel,
/// a solarization band on smooth shadow gradients that survives AgX
/// (monotone view transform). 1.5 EV (2.83×) keeps a ~6 % margin. Constants
/// are spec-"calibrated" values; the mix formula itself is unchanged.
pub(crate) const S_GAIN_EV: f32 = 1.5;

/// Highlights engagement band: `w_h(Y) = smoothstep(H_W0, H_W1, Y)` — the
/// slider acts on bright-but-unclipped tones (below the Y=1 knee), strongest
/// at and above the knee. Pre-#1103 the slider only acted above Y = 1.0.
///
/// H_W0 calibration (0.25, not the spec's 0.4 initial value): post-DCP
/// scene-linear normalizes diffuse white to ≈ 1.0, so real scenes put almost
/// all "bright" content below Y ≈ 0.5 — on the test_0004 reference frame the
/// luma histogram tops out at 0.99 with only 1.7 % of pixels above 0.4, and
/// with H_W0 = 0.4 the slider rail moved the display-referred top-1 % by
/// < 1/255 (ACR's Highlights2012 rail moves the same scene's top-5 % by
/// ≈ ±20/255). 0.25 starts the band just above mid-grey (w_h ≡ 0 exactly at
/// Y ≤ 0.25 ⊇ the 0.18 anchor — midtones stay brightness's domain) and
/// engages over the tones the histogram actually contains.
pub(crate) const H_W0: f32 = 0.25;
pub(crate) const H_W1: f32 = 1.0;
/// Weighted-gain strength in EV at slider ±100 (`exp2(∓H_GAIN_EV · w_h)`).
/// MONOTONICITY BOUND: the below-knee output `Y · exp2(−a·w_h(Y))` (a =
/// H_GAIN_EV · h/100) is strictly increasing in Y only while
/// `a · ln2 · max(w_h'(Y)·Y) < 1`; for the (0.25, 1.0) band the max of
/// `w_h'(Y)·Y` is ≈ 1.345, so `a` must stay < 1.07. Keep H_GAIN_EV well
/// under it — a tone curve that reverses direction mid-gradient posterizes
/// skies.
pub(crate) const H_GAIN_EV: f32 = 0.7;

// ----------------------------------------------------------------------
// Whites / blacks monotonicity bounds (#1918). Same methodology as the
// shadows/highlights gain caps above: keep d(out)/d(in) > 0 across the
// full documented ±100 slider range so a reachable slider setting can't
// invert local tonal ordering (a solarization band in gradients).
// ----------------------------------------------------------------------

/// Whites negative-gain floor. The whites point-op is
/// `T(Y) = Y · (1 + a · smoothstep(0.5, 1.0, Y))`, so
/// `T'(Y) = 1 + a · M(Y)` with `M(Y) = s(Y) + Y·s'(Y)`; `M` peaks at
/// `M_max ≈ 2.9716` (Y ≈ 0.820). `T'` goes negative once `a < −1/M_max ≈
/// −0.3365`, i.e. at `whites ≈ −67` (`a = whites/200`) — inside the ±100
/// range. Positive `a` is unconditionally monotone (`M ≥ 0`), so only the
/// negative side is floored; the effective gain saturates at `−0.32`
/// (≈5 % margin) for `whites < −64` instead of solarizing.
pub(crate) const WHITES_MIN_GAIN: f32 = 0.32;

/// Blacks negative-crush smoothstep edge — the toe weight is
/// `w = 1 − smoothstep(0, B_CRUSH_EDGE, Y)`. The multiplicative crush
/// `Y · (1 + b·w)` (`b = blacks/100 ∈ [−1, 0]`) is already monotone at this
/// 0.2 edge, so it is unchanged from the pre-#1918 stage.
pub(crate) const B_CRUSH_EDGE: f32 = 0.2;

/// Blacks positive-lift smoothstep edge. The additive lift
/// `T(Y) = Y + c·(1 − smoothstep(0, B_LIFT_EDGE, Y))`
/// (`c = B_LIFT_MAX·blacks/100 ∈ [0, B_LIFT_MAX]`) has
/// `T'(Y) = 1 − c · s'(Y)` with `max s'(Y) = 1.5/E` at `Y = E/2`.
/// #1918 widened the edge to 0.40 while retaining the legacy
/// 0.25 endpoint; that stayed monotone but made positive Blacks reach
/// scene-linear midtones. #2186 restores the 0.20 black-range edge and halves
/// the full-rail lift to 0.125. The same monotonicity margin remains:
/// `T'_min = 1 − 0.125·1.5/0.20 = 0.0625`.
pub(crate) const B_LIFT_EDGE: f32 = 0.20;
pub(crate) const B_LIFT_MAX: f32 = 0.125;

/// Detail-mask blur scale: σ = SH_MASK_SIGMA_REF_PX · longEdge /
/// SH_MASK_REF_LONG_EDGE — the same long-edge convention the spec assigns to
/// resolution-dependent radii, so fast-phase, refine, and export agree.
const SH_MASK_SIGMA_REF_PX: f32 = 15.0;
const SH_MASK_REF_LONG_EDGE: f32 = 2000.0;
/// Halo-protection edge thresholds: `edge = |√Y − √Yb|`,
/// `halo = smoothstep(SH_MASK_EDGE0, SH_MASK_EDGE1, edge)`.
const SH_MASK_EDGE0: f32 = 0.05;
const SH_MASK_EDGE1: f32 = 0.25;

/// Blur radius (in `gaussian_blur_plane` terms) for the S/H detail mask at a
/// given image long edge. `gaussian_blur_plane(radius)` runs 3 box passes of
/// `radius/3`, approximating a Gaussian with σ ≈ radius/3 (Wells 1986) — so
/// `radius = 3σ` yields the spec's σ = 15 px · longEdge/2000.
pub fn sh_mask_blur_radius(long_edge: usize) -> usize {
    let sigma = SH_MASK_SIGMA_REF_PX * (long_edge as f32) / SH_MASK_REF_LONG_EDGE;
    ((3.0 * sigma).round() as usize).max(1)
}

/// Effective spatial reach of this stage, in pixels per side at the rendered
/// resolution — FOR THE FUTURE TILE-OVERLAP CALCULATOR (#11 / tone-zoom
/// design § 5.3): every spatial stage registers `effective_radius(scale)`.
///
/// Two cascaded masked steps run when both sliders are active: highlights
/// blurs the live luma plane (reach ≈ `sh_mask_blur_radius` per side — three
/// box passes of radius/3 each reach radius/3, summing to ≈ radius), and the
/// shadows blur then reads the *highlights output*, so the reaches compound
/// rather than overlap: total = 2 × blur radius.
pub fn sh_mask_reach_px(long_edge: usize) -> usize {
    2 * sh_mask_blur_radius(long_edge)
}

/// Shadows multiplier at luma `y` (#1103, spec § 4.2). `s_amount` = slider/100.
///
/// `w_s(Y) = (1 − smoothstep(0, S_T1, Y))²`, `mult = mix(1, exp2(S_GAIN_EV·s),
/// w_s)` — the squared falloff concentrates the action in the deepest tones
/// while the wider S_T1 lets it reach real shadows. Sign convention is
/// UNCHANGED from the pre-#1103 stage: positive lifts (mult > 1), negative
/// crushes (mult < 1, never ≤ 0 since `exp2 > 0` and `w_s ≤ 1`). Exactly 1.0
/// at `Y ≥ S_T1` (w_s = 0 ⇒ the mix term vanishes bit-exactly). Monotone in
/// Y by the S_GAIN_EV bound documented at the constant.
#[inline]
pub(crate) fn shadows_mult(y: f32, s_amount: f32) -> f32 {
    let t = 1.0 - smoothstep(0.0, S_T1, y);
    let w = t * t;
    1.0 + ((S_GAIN_EV * s_amount).exp2() - 1.0) * w
}

/// Highlights multiplier at luma `y` (#1103, spec § 4.2). `h_amount` =
/// slider/100; `h_denom`/`h_expand` are hoisted by the caller.
///
/// Two composed factors, both uniform scalars (hue-preserving):
///
/// 1. **Weighted gain** `g = exp2(−H_GAIN_EV · h · w_h(Y))` with
///    `w_h(Y) = smoothstep(H_W0, H_W1, Y)` — this is what makes the slider
///    act below clip: positive h darkens bright-but-unclipped tones toward
///    the knee, negative h brightens them. Sign convention UNCHANGED:
///    positive = recover/compress, negative = gain (matches the pre-#1103
///    above-knee directions, so existing sidecars do not invert).
/// 2. **Above-knee shape** (Y > 1), sign-branched:
///    - h ≥ 0: the existing `Y' = 1 + (Y−1)/(1 + 2h)` compression is KEPT
///      (spec: scene range is shaped, never clipped — AgX still owns final
///      path-to-white).
///    - h < 0: `Y' = 1 + (Y−1)·(1 + 2|h|)` — the pole-free mirror from
///      #1081 / PR #1117. The legacy shared denominator crossed zero at
///      h = −50 (silent identity at exactly −50, ~167× blowups just above,
///      negative RGB below). Both branch factors are ≥ 1: NO POLE anywhere
///      in the slider range. Do not collapse the branches back into one
///      denominator.
///
/// Monotone in Y on both signs (see the H_GAIN_EV bound above; above the
/// knee `w_h ≡ 1` so `g` is constant and the shape term is increasing), and
/// continuous through the knee (shape → 1 as Y → 1⁺).
#[inline]
pub(crate) fn highlights_mult(y: f32, h_amount: f32, h_denom: f32, h_expand: f32) -> f32 {
    let w = smoothstep(H_W0, H_W1, y);
    let g = (-H_GAIN_EV * h_amount * w).exp2();
    let shape = if y > 1.0 {
        let y_new = if h_amount >= 0.0 {
            1.0 + (y - 1.0) / h_denom
        } else {
            1.0 + (y - 1.0) * h_expand
        };
        y_new / y
    } else {
        1.0
    };
    shape * g
}

/// Apply a luminance-keyed multiplier through the tonal detail mask
/// (#1103, spec § 4.2 — RapidRAW-style halo-protected regional response):
///
/// ```text
/// Yb   = gaussian(Y, σ = 15px · longEdge/2000)   // regional luma
/// edge = |√Y − √Yb|                              // perceptual-ish edge measure
/// halo = smoothstep(0.05, 0.25, edge)
/// mult = mix(mult(Yb), mult(Y), halo)            // regional vs per-pixel
/// ```
///
/// In smooth or finely-textured regions the blurred (regional) luma drives
/// the multiplier — every pixel of a texture patch receives the same gain,
/// preserving local contrast ratios (pushed shadows stop going muddy). At
/// strong edges the mask falls back to the per-pixel response, which is what
/// prevents halos. On a uniform field `Yb == Y` (modulo box-blur float
/// round-off), the mix degenerates to the per-pixel curve, and the
/// closed-form grey predictors hold.
///
/// `√` operands are clamped at 0: scene-linear buffers legitimately carry
/// small negatives (this stage must pass them through, see the
/// `scene_referred_does_not_clip_negatives_introduced_upstream` test) and
/// `sqrt(-x)` would poison the mask with NaN.
fn masked_multiplier_pass(img: &mut Image, mult_of_y: impl Fn(f32) -> f32) {
    let w = img.width as usize;
    let h = img.height as usize;
    let luma_plane: Vec<f32> = img
        .pixels
        .iter()
        .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
        .collect();
    let radius = sh_mask_blur_radius(w.max(h));
    let yb = gaussian_blur_plane(&luma_plane, w, h, radius);

    for (i, p) in img.pixels.iter_mut().enumerate() {
        let y = luma_plane[i];
        let ybi = yb[i];
        let edge = (y.max(0.0).sqrt() - ybi.max(0.0).sqrt()).abs();
        let halo = smoothstep(SH_MASK_EDGE0, SH_MASK_EDGE1, edge);
        let m_regional = mult_of_y(ybi);
        let m_local = mult_of_y(y);
        let mult = m_regional + (m_local - m_regional) * halo;
        p[0] *= mult;
        p[1] *= mult;
        p[2] *= mult;
    }
}

/// Apply scene-referred tone controls per spec § 3.6 + tone/zoom design
/// § 4.1–4.2. Steps 1–5b (exposure, brightness, highlights, shadows, whites,
/// blacks); tone curves (steps 6–7) deferred. Contrast is NOT applied here;
/// it modulates the AgX sigmoid slope downstream (spec § 3.6a).
///
/// Structure (#1103): the point-op steps run in per-pixel loops exactly as
/// before; highlights and shadows each run as a full-image masked pass (the
/// detail mask needs a blurred luma plane of the image state ENTERING that
/// step — blurring per step is what keeps the grey-card predictors a simple
/// left-to-right composition). Step order and per-step sequential-luma
/// semantics are unchanged: each step sees the previous step's output.
pub fn apply(img: &mut Image, model: &AdjustmentModel) {
    img.assert_space(ColorSpace::SceneLinearRec2020);

    // Identity short-circuit: if every field this stage touches is zero,
    // the pipeline's bit-for-bit baseline guarantee must hold.
    if model.exposure.abs() < 1e-6
        && model.brightness.abs() < 1e-3
        && model.highlights.abs() < 1e-3
        && model.shadows.abs() < 1e-3
        && model.whites.abs() < 1e-3
        && model.blacks.abs() < 1e-3
    {
        return;
    }

    let exp_gain = model.exposure.exp2();
    let apply_exposure = model.exposure.abs() >= 1e-6;
    let apply_brightness = model.brightness.abs() >= 1e-3;
    let apply_highlights = model.highlights.abs() >= 1e-3;
    let apply_shadows = model.shadows.abs() >= 1e-3;
    let apply_whites = model.whites.abs() >= 1e-3;
    let apply_blacks = model.blacks.abs() >= 1e-3;

    // Brightness: EV-per-unit-weight amount (spec § 4.1). The per-pixel
    // gain is `exp2(br_amount · w(Y))` with w the midtone band weight.
    let br_amount = B_STRENGTH * model.brightness / 100.0;

    // Highlights (#1103): weighted-gain amount + the sign-branched
    // above-knee factors (see `highlights_mult`).
    let h_amount = model.highlights / 100.0;
    let h_denom = 1.0 + h_amount * 2.0; // ≥ 1 whenever the h ≥ 0 branch uses it
    let h_expand = 1.0 + 2.0 * h_amount.abs(); // ≥ 1, used by the h < 0 branch
                                               // Shadows (#1103): see `shadows_mult`.
    let s_amount = model.shadows / 100.0;
    // Whites: smoothstep-weighted upper-end gain (see step 4). The negative
    // side is floored at the monotonicity bound (#1918, WHITES_MIN_GAIN);
    // positive gain is unconditionally monotone and passes through unclamped.
    let w_amount = (model.whites / 200.0).max(-WHITES_MIN_GAIN);
    // Blacks: smoothstep-weighted toe (see step 5). The amount has two
    // shapes depending on sign — see comment block at the call site.
    let b_amount = model.blacks / 100.0; // -1..+1
    let b_add_pos = B_LIFT_MAX * model.blacks / 100.0;

    // 1 + 1b. Exposure, then brightness — point ops.
    if apply_exposure || apply_brightness {
        for p in &mut img.pixels {
            // 1. Exposure.
            if apply_exposure {
                p[0] *= exp_gain;
                p[1] *= exp_gain;
                p[2] *= exp_gain;
            }

            // 1b. Brightness — midtone-band gain (#1102, spec § 4.1).
            //
            // Moves midtones only, pinning deep shadows and the highlight end:
            //   Y    = dot(LUMA_REC2020, p)
            //   w(Y) = smoothstep(0.05, 0.25, Y) · (1 − smoothstep(1.0, 4.0, Y))
            //   gain = exp2(0.7 · b/100 · w(Y))
            // Y ≤ 0.05 and Y ≥ 4.0 see gain exactly 1.0 (w = 0), so the
            // histogram ends stay the blacks/shadows and exposure/highlights
            // sliders' domain. Hue is preserved by construction: the only
            // operation on RGB is a uniform scalar multiply.
            if apply_brightness {
                let y = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
                let w = smoothstep(B_LO0, B_LO1, y) * (1.0 - smoothstep(B_HI0, B_HI1, y));
                let gain = (br_amount * w).exp2();
                p[0] *= gain;
                p[1] *= gain;
                p[2] *= gain;
            }
        }
    }

    // 2. Highlights — masked pass (#1103). The luma the multiplier (and its
    //    regional blur) sees is the post-exposure/brightness state.
    if apply_highlights {
        masked_multiplier_pass(img, |y| highlights_mult(y, h_amount, h_denom, h_expand));
    }

    // 3. Shadows — masked pass (#1103), reading the post-highlights state.
    if apply_shadows {
        masked_multiplier_pass(img, |y| shadows_mult(y, s_amount));
    }

    // 4 + 5. Whites, then blacks — point ops (unchanged from pre-#1103).
    if apply_whites || apply_blacks {
        for p in &mut img.pixels {
            // 4. Whites — smoothstep-weighted gain near the diffuse-white
            // endpoint.
            //
            // Pre-fix (#267): uniform scalar gain `1 + whites/200` brightened
            // every pixel including mid-gray. The reference renderer's whites
            // slider weights its action near the upper end of the
            // diffuse-white range and leaves midtones untouched.
            //
            // Post-fix: weight the gain by smoothstep(0.5, 1.0, Y). At Y=0.5
            // the weight is 0 → gain=1.0 → no change. At Y=1.0+ the weight
            // saturates to 1 → full whites/200 gain. RGB is scaled uniformly
            // by the same factor so hue is preserved.
            if apply_whites {
                let y_old =
                    LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
                let w = smoothstep(0.5, 1.0, y_old);
                let w_gain = 1.0 + w_amount * w;
                p[0] *= w_gain;
                p[1] *= w_gain;
                p[2] *= w_gain;
            }

            // 5. Blacks — smoothstep-weighted toe curve.
            //
            // Pre-fix (#268): additive shift `p += blacks/400` clamped at
            // zero. The clamp prevented the magenta-shadow Bug A (negative
            // scene values funnelling per-channel through AgX), but turned
            // negative blacks into a hard floor — every pixel below the
            // threshold collapsed to absolute zero, destroying tonal
            // contrast.
            //
            // Post-fix: parametric toe weighted by w = 1 - smoothstep(0, 0.2, Y).
            // The weight is 1 near zero, falls to 0 above Y=0.2, so midtones
            // are untouched in either direction.
            //
            // - blacks < 0 (crush): multiplicative compression scaled by w.
            //   factor = 1 + (blacks/100) * w → in [0, 1] as blacks ranges
            //   [-100, 0]. p_new = p * factor. Zero stays zero (no negative
            //   scene values possible), but deep shadows retain a smooth toe
            //   instead of clipping flat to zero.
            //
            // - blacks > 0 (lift): additive shift scaled by w.
            //   delta = 0.125 * (blacks/100) * w. At Y=0 with blacks=+100,
            //   w=1 → delta=0.125. Above Y=0.2 the lift dies off so midtones
            //   aren't pushed up (#2186). The asymmetry between the two
            //   branches (multiplicative crush, additive lift) is
            //   intentional: a multiplicative lift would no-op p=0, but the
            //   user expectation for the legacy positive-blacks behaviour is
            //   that zero pixels lift to a positive value.
            //
            // No pixel can go negative scene-linear under either branch.
            // See investigation spec
            // .archived-plans/specs/2026-04-26-blacks-clarity-bug-investigation.md.
            if apply_blacks {
                let y_old =
                    LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
                if b_amount < 0.0 {
                    // Crush: multiplicative, toe weight over the 0.2 edge
                    // (already monotone — unchanged, #1918).
                    let w = 1.0 - smoothstep(0.0, B_CRUSH_EDGE, y_old);
                    let factor = 1.0 + b_amount * w;
                    p[0] *= factor;
                    p[1] *= factor;
                    p[2] *= factor;
                } else {
                    // Lift: additive over the 0.20 black-range edge. The 0.125
                    // full-rail endpoint keeps the transfer monotone (#2186).
                    let w = 1.0 - smoothstep(0.0, B_LIFT_EDGE, y_old);
                    let delta = b_add_pos * w;
                    if y_old > 1e-6 {
                        let y_new = y_old + delta;
                        let scale = y_new / y_old;
                        p[0] *= scale;
                        p[1] *= scale;
                        p[2] *= scale;
                    } else {
                        p[0] += delta;
                        p[1] += delta;
                        p[2] += delta;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_brightness;
#[cfg(test)]
mod tests_hue;
#[cfg(test)]
mod tests_sh_mask;

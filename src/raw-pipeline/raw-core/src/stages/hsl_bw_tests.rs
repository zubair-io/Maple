//! Unit tests for the black-and-white half of [`super`] (#276).
//!
//! Sibling of `hsl_tests.rs`; split for the 600-LOC file-size budget. The
//! B&W path shares the HSL path's band partition (`HUE_CENTERS_DEG`,
//! `BAND_HALF_WIDTH_DEG`, `CHROMA_GATE_C0`) — there is deliberately no
//! second set of band constants — so these tests cover what is specific to
//! monochrome: chroma really reaching zero, the mixer steering `L` per
//! band, and the conversion staying smooth across band boundaries.

use super::*;
use crate::color::oklab::rec2020_to_oklab;
use crate::image::{ColorSpace, Image};

const BANDS: usize = NUM_BANDS;

fn zero_bands() -> [f32; NUM_BANDS] {
    [0.0; NUM_BANDS]
}

/// A scene-linear Rec.2020 pixel at the given Oklab (L, C, hue°).
fn oklab_polar(l: f32, c: f32, hue_deg: f32) -> [f32; 3] {
    let rad = hue_deg.to_radians();
    crate::color::oklab::oklab_to_rec2020([l, c * rad.cos(), c * rad.sin()])
}

fn bw_params(mix: [f32; NUM_BANDS]) -> HslParams {
    hsl_params(&zero_bands(), &zero_bands(), &zero_bands(), &mix, true)
}

// ── Chroma is forced to zero ───────────────────────────────────────────

/// The ticket's "saturation forced to 0": with B&W armed, EVERY pixel
/// leaves with zero Oklab chroma — including pixels below the chroma gate,
/// which the colour path returns bit-identically. A residual tint on
/// near-neutrals is exactly the bug this asserts against.
#[test]
fn every_pixel_leaves_neutral() {
    let p = bw_params([0.0; NUM_BANDS]);
    // Sweep chroma from far below the gate (0.001) to well above it, at a
    // spread of hues and two lightnesses.
    for &c_in in &[0.001_f32, 0.01, 0.049, 0.05, 0.08, 0.15, 0.25] {
        for hue_step in 0..24 {
            let hue = hue_step as f32 * 15.0;
            for &l_in in &[0.25_f32, 0.7] {
                let out = apply_pixel(oklab_polar(l_in, c_in, hue), &p);
                let lab = rec2020_to_oklab(out);
                let c_out = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
                assert!(
                    c_out < 1e-4,
                    "L={l_in} C={c_in} hue={hue}°: residual chroma {c_out:.3e} \
                     (output {out:?})"
                );
            }
        }
    }
}

/// A flat mixer must not move lightness — B&W with all weights at 0 is a
/// pure desaturation, not a brightness change.
#[test]
fn flat_mixer_preserves_lightness() {
    let p = bw_params([0.0; NUM_BANDS]);
    for hue_step in 0..36 {
        let hue = hue_step as f32 * 10.0;
        let l_in = 0.55_f32;
        let out = apply_pixel(oklab_polar(l_in, 0.12, hue), &p);
        let l_out = rec2020_to_oklab(out)[0];
        assert!(
            (l_out - l_in).abs() < 1e-4,
            "hue {hue}°: flat mixer moved L from {l_in} to {l_out}"
        );
    }
}

/// Grey input is untouched: chroma is already zero, hue is undefined, so
/// no band claims the pixel however the mixer is set.
///
/// Tolerance is the Oklab round-trip's own noise floor, not a slack
/// budget. Unlike the colour path — which returns near-neutrals
/// bit-identically via its `C < CHROMA_GATE_C0` early return — the B&W
/// path must round-trip every pixel through Oklab in order to zero its
/// chroma, and `rec2020 → Oklab → rec2020` on the neutral axis lands
/// within ~2e-5 of the input rather than exactly on it.
#[test]
fn neutral_input_is_unchanged_for_any_mixer() {
    for band in 0..BANDS {
        for &v in &[-100.0_f32, 100.0] {
            let mut mix = zero_bands();
            mix[band] = v;
            let p = bw_params(mix);
            let out = apply_pixel([0.18, 0.18, 0.18], &p);
            for ch in 0..3 {
                assert!(
                    (out[ch] - 0.18).abs() < 1e-4,
                    "mixer[{band}]={v}: grey moved to {out:?}"
                );
            }
        }
    }
}

// ── The mixer steers L per band ────────────────────────────────────────

/// A single band's weight brightens/darkens the hue at that band's centre
/// and leaves the hue diametrically opposite it (which the raised cosine
/// gives zero weight) alone. This is what makes the tool useful: a red
/// filter must darken reds without touching cyans.
#[test]
fn single_band_weight_steers_its_own_hue() {
    for band in 0..BANDS {
        let centre = HUE_CENTERS_DEG[band];
        let opposite = (centre + 180.0) % 360.0;
        for &v in &[-80.0_f32, 80.0] {
            let mut mix = zero_bands();
            mix[band] = v;
            let p = bw_params(mix);

            let l_at_centre = rec2020_to_oklab(apply_pixel(oklab_polar(0.5, 0.15, centre), &p))[0];
            let l_at_opposite =
                rec2020_to_oklab(apply_pixel(oklab_polar(0.5, 0.15, opposite), &p))[0];

            if v > 0.0 {
                assert!(
                    l_at_centre > 0.5 + 1e-3,
                    "band {band} (+{v}) at its own hue {centre}°: L {l_at_centre} not brightened"
                );
            } else {
                assert!(
                    l_at_centre < 0.5 - 1e-3,
                    "band {band} ({v}) at its own hue {centre}°: L {l_at_centre} not darkened"
                );
            }
            // 180° away is more than the 67.5° half-width, so the weight is
            // exactly zero there.
            assert!(
                (l_at_opposite - 0.5).abs() < 1e-4,
                "band {band} ({v}) leaked to the opposite hue {opposite}°: L {l_at_opposite}"
            );
        }
    }
}

/// The mix ramps in with chroma rather than switching on at the gate: a
/// pixel just above `CHROMA_GATE_C0` gets a fraction of the weight, one
/// well above it gets the full weight. Without this the conversion would
/// show a hard edge wherever a gradient crosses the gate.
#[test]
fn mix_ramps_in_with_chroma() {
    let mut mix = zero_bands();
    mix[0] = 100.0; // Red
    let p = bw_params(mix);
    let hue = HUE_CENTERS_DEG[0];

    let l_of = |c: f32| rec2020_to_oklab(apply_pixel(oklab_polar(0.5, c, hue), &p))[0];
    let l_below = l_of(CHROMA_GATE_C0 * 0.9);
    let l_mid = l_of(CHROMA_GATE_C0 * 1.5);
    let l_above = l_of(CHROMA_GATE_C0 * 3.0);

    assert!(
        (l_below - 0.5).abs() < 1e-4,
        "below the gate the mixer must not apply: L {l_below}"
    );
    assert!(
        l_mid > l_below + 1e-3 && l_mid < l_above - 1e-3,
        "mid-gate L {l_mid} is not strictly between {l_below} and {l_above}"
    );
}

// ── Band-boundary smoothness (#276 acceptance: "no posterization") ─────

/// A fine hue sweep at fixed L and chroma must produce a monochrome output
/// that varies *smoothly* with input hue. The eight mixer weights blend
/// through the same normalized raised-cosine partition the HSL path uses,
/// so there is no step at any band edge; posterization would appear as a
/// discontinuity — one 0.25° step whose output jump dwarfs its neighbours'.
///
/// The assertion is on the SECOND difference of the output signal, the
/// same shape as the HSL path's `hue_sweep_has_no_band_boundary_discontinuity`
/// and the `banding_check.py` CI gate (#1627): for a C¹ signal on a uniform
/// grid `|f(i+1) − 2·f(i) + f(i−1)|` stays at the curvature scale, whereas
/// a hard band edge spikes it. The bound is a multiple of the largest first
/// difference so the test is scale-free rather than pinned to a magic delta.
///
/// **Red-checked** by replacing `raised_cosine_weight` in
/// `super::band_weights` with a hard box window
/// (`if delta_deg < half_width_deg { 1.0 } else { 0.0 }`): the second
/// difference then reaches the first-difference scale and this test fails
/// on every channel.
#[test]
fn bw_hue_sweep_has_no_band_boundary_discontinuity() {
    // Alternating ±80 across the eight bands maximises the gradient at
    // every band boundary — adjacent bands pull L in opposite directions.
    let mix: [f32; NUM_BANDS] =
        std::array::from_fn(|band| if band % 2 == 0 { 80.0 } else { -80.0 });
    let p = bw_params(mix);

    // 1440 samples = 0.25° steps around the full hue circle, at a chroma
    // well above the gate ramp (so the gate is a constant 1.0 and the only
    // thing varying is the band mixture) and inside the Rec.2020 hull at
    // L = 0.5.
    const STEPS: usize = 1440;
    const C_IN: f32 = 0.06;
    let outputs: Vec<[f32; 3]> = (0..STEPS)
        .map(|i| {
            let h = (i as f32) * (360.0 / STEPS as f32);
            apply_pixel(oklab_polar(0.5, C_IN, h), &p)
        })
        .collect();

    for channel in 0..3 {
        let f = |i: usize| outputs[i % STEPS][channel];
        let first_diff_max = (0..STEPS)
            .map(|i| (f(i + 1) - f(i)).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            first_diff_max > 0.0,
            "channel {channel}: sweep is constant — the stage did nothing"
        );
        let (worst_index, worst_second_diff) = (0..STEPS)
            .map(|i| {
                (
                    i,
                    (f(i + STEPS + 1) - 2.0 * f(i + STEPS) + f(i + STEPS - 1)).abs(),
                )
            })
            .fold(
                (0usize, 0.0_f32),
                |acc, x| if x.1 > acc.1 { x } else { acc },
            );
        assert!(
            worst_second_diff < 0.25 * first_diff_max,
            "channel {channel}: B&W hue-band discontinuity at sample {worst_index} \
             ({:.3}°): second difference {worst_second_diff:.3e} vs max first \
             difference {first_diff_max:.3e}",
            worst_index as f32 * (360.0 / STEPS as f32)
        );
    }
}

// ── Mode interaction ───────────────────────────────────────────────────

/// B&W is never short-circuited as identity: arming it with an untouched
/// mixer and untouched HSL sliders must still convert the image.
#[test]
fn bw_is_never_identity() {
    let p = hsl_params(
        &zero_bands(),
        &zero_bands(),
        &zero_bands(),
        &zero_bands(),
        true,
    );
    assert!(
        !p.is_identity,
        "B&W must not take the identity short-circuit"
    );

    let mut img = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = oklab_polar(0.5, 0.15, 30.0);
    img.pixels[1] = oklab_polar(0.5, 0.15, 210.0);
    let before = img.pixels.clone();
    apply(
        &mut img,
        &zero_bands(),
        &zero_bands(),
        &zero_bands(),
        &zero_bands(),
        true,
    );
    assert_ne!(img.pixels, before, "B&W must have converted the pixels");
}

/// The 24 HSL sliders are inert while B&W is armed — the mode is an
/// either/or, matching the front-ends hiding the Hue/Saturation panel.
#[test]
fn hsl_sliders_are_inert_under_bw() {
    let mut hue = zero_bands();
    let mut sat = zero_bands();
    let mut lum = zero_bands();
    for band in 0..BANDS {
        hue[band] = 100.0;
        sat[band] = -100.0;
        lum[band] = 100.0;
    }
    let with_hsl = hsl_params(&hue, &sat, &lum, &zero_bands(), true);
    let without_hsl = bw_params([0.0; NUM_BANDS]);

    for hue_step in 0..36 {
        let px = oklab_polar(0.5, 0.15, hue_step as f32 * 10.0);
        let a = apply_pixel(px, &with_hsl);
        let b = apply_pixel(px, &without_hsl);
        assert_eq!(
            a, b,
            "HSL sliders leaked into the B&W path at hue step {hue_step}"
        );
    }
}

/// With B&W off, the mixer weights are inert — a sidecar can carry a mix
/// alongside a colour render without changing it.
#[test]
fn mixer_is_inert_when_bw_is_off() {
    let mix: [f32; NUM_BANDS] = [100.0; NUM_BANDS];
    let p = hsl_params(&zero_bands(), &zero_bands(), &zero_bands(), &mix, false);
    assert!(
        p.is_identity,
        "mixer alone must leave the stage at identity while B&W is off"
    );
}

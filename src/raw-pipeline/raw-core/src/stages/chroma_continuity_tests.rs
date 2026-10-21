//! #4664: exercise the whole scene operator across the gamut boundary.
//! Testing its scalar knee alone misses a discontinuous fast-path dispatch.
use super::{hsl, local_adjustments, saturation, vibrance};
use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};

fn assert_continuous(stage: &str, apply: impl Fn([f32; 3]) -> [f32; 3]) {
    const STEPS: usize = 4096;
    const STEP: f32 = 0.45 / STEPS as f32;
    // The authored scales are at most two. Allow twice that slope plus
    // float round-trip error; a branch dropping 10% of the hull cannot hide.
    const STEP_BOUND: f32 = 4.0 * STEP + 2e-5;
    for lightness in [0.35, 0.55, 0.75, 1.25] {
        for hue in [
            0.0_f32, 30.0, 35.0, 60.0, 90.0, 110.0, 150.0, 180.0, 240.0, 300.0,
        ] {
            let (sin, cos) = hue.to_radians().sin_cos();
            let mut previous = 0.0;
            for i in 1..=STEPS {
                let chroma = i as f32 * STEP;
                let input = oklab_to_rec2020([lightness, chroma * cos, chroma * sin]);
                // Follow physical nonnegative scene colors up to their hull.
                // The doubled target crosses the hull earlier. Far outside
                // the input cone, near-zero LMS cancellation makes an f32
                // Oklab round-trip non-monotone and is a different property.
                if input.iter().any(|v| *v < 0.0) {
                    break;
                }
                let output = rec2020_to_oklab(apply(input));
                let current = output[1].hypot(output[2]);
                let delta = current - previous;
                assert!(
                    delta >= -2e-5 && delta <= STEP_BOUND,
                    "{stage}: L={lightness} h={hue} C={chroma}: chroma step {delta} exceeds continuous-scale bound {STEP_BOUND}"
                );
                previous = current;
            }
        }
    }
}

#[test]
fn saturation_chroma_ramp_crosses_hull_continuously() {
    assert_continuous("saturation", |p| saturation::apply_pixel(p, 2.0));
}

#[test]
fn vibrance_chroma_ramp_crosses_hull_continuously() {
    assert_continuous("vibrance", |p| vibrance::apply_pixel(p, 1.0));
}

#[test]
fn hsl_chroma_ramp_crosses_hull_continuously() {
    let params = hsl::HslParams {
        hue_rad: [0.0; 8],
        sat_scale: [2.0; 8],
        lum_shift: [0.0; 8],
        bw_mix: [0.0; 8],
        bw_active: false,
        is_identity: false,
    };
    assert_continuous("hsl", |p| hsl::apply_pixel(p, &params));
}

#[test]
fn hsl_small_edits_do_not_jump_from_identity_near_hull() {
    for l in [0.35, 0.55, 0.75, 1.25] {
        for hue in [0.0_f32, 30.0, 60.0, 90.0, 150.0, 180.0, 240.0, 300.0] {
            let (sin, cos) = hue.to_radians().sin_cos();
            let hull = saturation::bisect_gamut_hull(l, cos, sin, 2.0);
            let input = oklab_to_rec2020([l, 0.9 * hull * cos, 0.9 * hull * sin]);
            let lab = rec2020_to_oklab(input);
            for control in 0..3 {
                for amount in [-0.01, 0.01] {
                    let mut sliders = [[0.0; 8]; 3];
                    sliders[control] = [amount; 8];
                    let params =
                        hsl::hsl_params(&sliders[0], &sliders[1], &sliders[2], &[0.0; 8], false);
                    let output = rec2020_to_oklab(hsl::apply_pixel(input, &params));
                    let distance = output
                        .iter()
                        .zip(lab)
                        .map(|(a, b)| (a - b).powi(2))
                        .sum::<f32>()
                        .sqrt();
                    assert!(distance < 1e-3,
                        "L={l} h={hue} control={control} amount={amount}: tiny edit moved Oklab by {distance}");
                }
            }
        }
    }
}

#[test]
fn hsl_saturation_slider_is_monotone_near_hull() {
    for l in [0.35, 0.55, 0.75, 1.25] {
        for hue in [0.0_f32, 30.0, 60.0, 90.0, 150.0, 180.0, 240.0, 300.0] {
            let (sin, cos) = hue.to_radians().sin_cos();
            let hull = saturation::bisect_gamut_hull(l, cos, sin, 2.0);
            for fraction in [0.7, 0.9, 0.99] {
                let input = oklab_to_rec2020([l, fraction * hull * cos, fraction * hull * sin]);
                let mut previous = 0.0;
                for step in -1000..=1000 {
                    let amount = step as f32 * 0.1;
                    let params =
                        hsl::hsl_params(&[0.0; 8], &[amount; 8], &[0.0; 8], &[0.0; 8], false);
                    let output = rec2020_to_oklab(hsl::apply_pixel(input, &params));
                    let chroma = output[1].hypot(output[2]);
                    assert!(chroma - previous >= -2e-5,
                        "L={l} h={hue} fraction={fraction} sat={amount}: chroma {previous} -> {chroma}");
                    previous = chroma;
                }
            }
        }
    }
}

fn oklab_distance(x: [f32; 3], y: [f32; 3]) -> f32 {
    x.iter()
        .zip(y)
        .map(|(a, b)| (a - b).powi(2))
        .sum::<f32>()
        .sqrt()
}

#[test]
fn local_hue_rotation_crosses_hull_continuously() {
    const STEP_RAD: f32 = 1e-3;
    // Rotating 1 mrad moves chroma <= 0.4 by <= 4e-4; the hull's own hue slope
    // stays well inside 10x that. The old dispatch dropped 10% of hull chroma.
    const STEP_BOUND: f32 = 4e-3;
    for l in [0.35, 0.55, 0.75, 1.25] {
        for hue in [0.0_f32, 30.0, 60.0, 90.0, 150.0, 180.0, 240.0, 300.0] {
            let (sin, cos) = hue.to_radians().sin_cos();
            let hull = saturation::bisect_gamut_hull(l, cos, sin, 2.0);
            for fraction in [0.85, 0.95, 0.99] {
                let input = oklab_to_rec2020([l, fraction * hull * cos, fraction * hull * sin]);
                let mut previous = rec2020_to_oklab(input);
                for step in 1..=3142 {
                    let delta = step as f32 * STEP_RAD;
                    let output =
                        rec2020_to_oklab(local_adjustments::hue::rotate_pixel(input, delta));
                    let moved = oklab_distance(output, previous);
                    assert!(
                        moved <= STEP_BOUND,
                        "L={l} h={hue} fraction={fraction} delta={delta}: Oklab step {moved}"
                    );
                    previous = output;
                }
            }
        }
    }
}

#[test]
fn local_hue_small_rotation_does_not_jump_from_identity_near_hull() {
    for l in [0.35, 0.55, 0.75, 1.25] {
        for hue in [0.0_f32, 30.0, 60.0, 90.0, 150.0, 180.0, 240.0, 300.0] {
            let (sin, cos) = hue.to_radians().sin_cos();
            let hull = saturation::bisect_gamut_hull(l, cos, sin, 2.0);
            let input = oklab_to_rec2020([l, 0.95 * hull * cos, 0.95 * hull * sin]);
            let lab = rec2020_to_oklab(input);
            for delta in [-1e-4, 1e-4] {
                let output = rec2020_to_oklab(local_adjustments::hue::rotate_pixel(input, delta));
                let distance = oklab_distance(output, lab);
                assert!(
                    distance < 1e-3,
                    "L={l} h={hue} delta={delta}: moved Oklab by {distance}"
                );
            }
        }
    }
}

/// A colour already outside the gamut keeps the full soft shoulder under a
/// small HSL edit: chroma stays below the hull and strictly ordered across
/// a gradient, instead of every out-of-gamut input clipping to the hull.
#[test]
fn hsl_compresses_out_of_gamut_inputs_smoothly_and_in_order() {
    let mut sliders = [[0.0; 8]; 3];
    sliders[1] = [0.01; 8];
    let params = hsl::hsl_params(&sliders[0], &sliders[1], &sliders[2], &[0.0; 8], false);
    for l in [0.45, 0.65, 0.85] {
        for hue in [0.0_f32, 60.0, 150.0, 240.0, 300.0] {
            let (sin, cos) = hue.to_radians().sin_cos();
            let hull = saturation::bisect_gamut_hull(l, cos, sin, 2.0);
            let mut previous = 0.0;
            for k in 1..=10 {
                let chroma = hull * (1.0 + 0.05 * k as f32);
                let input = oklab_to_rec2020([l, chroma * cos, chroma * sin]);
                let output = rec2020_to_oklab(hsl::apply_pixel(input, &params));
                let c = output[1].hypot(output[2]);
                assert!(
                    c < 0.995 * hull && c > previous,
                    "L={l} h={hue} input {:.3}×hull: chroma {c} (hull {hull}, previous {previous})",
                    chroma / hull
                );
                previous = c;
            }
        }
    }
}

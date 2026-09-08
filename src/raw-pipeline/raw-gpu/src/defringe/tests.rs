//! Parity tests for the defringe WGSL kernel's GLOBAL band path (#3411).
//!
//! The per-mask path (#3407) is gated by `local_spatial/tests.rs`, which
//! drives the same kernel through `LocalSpatialPass`. Split out of
//! `defringe.rs` to keep that module under the 600-LOC budget (mirrors
//! saturation's / vignette's `tests.rs` split).

use super::*;
use crate::chain::ChainRunner;
use crate::context::GpuContext;
use crate::image::GpuImage;

/// A 2-D buffer built so every branch of the kernel is exercised:
/// hard-edged violet and green fringes (the stage's target), the same hues
/// in flat interiors (edge gate closed), out-of-band hues on hard edges
/// (hue gate closed), exact neutrals, near-black (the luma floor), and HDR
/// headroom. 24×16 so the gradient stencil sees real interiors as well as
/// the clamped border.
fn buffer_24x16() -> (Vec<f32>, u32, u32) {
    let (w, h) = (24u32, 16u32);
    let mut v = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let band = x / 4;
            let dark = y % 2 == 0;
            let (r, g, b) = match band {
                // Hard step with a violet fringe on the boundary column.
                0 => {
                    if x == 3 {
                        (0.30, 0.05, 0.55)
                    } else if dark {
                        (0.01, 0.01, 0.01)
                    } else {
                        (0.62, 0.60, 0.61)
                    }
                }
                // Hard step with a green fringe on the boundary column.
                1 => {
                    if x == 7 {
                        (0.06, 0.45, 0.10)
                    } else if dark {
                        (0.02, 0.02, 0.02)
                    } else {
                        (0.70, 0.68, 0.69)
                    }
                }
                // Flat violet interior — in band, but no edge.
                2 => (0.30, 0.05, 0.55),
                // Hard step with an ORANGE fringe — out of both bands.
                3 => {
                    if x == 15 {
                        (0.55, 0.22, 0.03)
                    } else if dark {
                        (0.01, 0.01, 0.01)
                    } else {
                        (0.60, 0.62, 0.60)
                    }
                }
                // Exact neutrals, one of them under the luma floor.
                4 => {
                    let l = if dark { 0.0 } else { 0.55 };
                    (l, l, l)
                }
                // HDR scene headroom with a magenta cast, hard-edged.
                _ => {
                    if x == 21 {
                        (4.00, 0.80, 5.00)
                    } else if dark {
                        (0.05, 0.05, 0.05)
                    } else {
                        (3.00, 3.10, 3.00)
                    }
                }
            };
            v.extend_from_slice(&[r, g, b, 1.0]);
        }
    }
    (v, w, h)
}

/// Run `raw_core::stages::defringe::apply_params` on a flat interleaved
/// RGBA f32 buffer, returning a new buffer (alpha carried through
/// untouched). The ticket's actual reference — the Rust stage itself, via
/// the test-only dev-dep.
fn raw_core_defringe(buf: &[f32], w: u32, h: u32, p: &DefringeInputs) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::defringe::apply_params(
        &mut img,
        &raw_core::stages::defringe::DefringeParams {
            all_hues_strength: p.all_hues_strength,
            purple_strength: p.purple_strength,
            purple_lo: p.purple_lo,
            purple_hi: p.purple_hi,
            green_strength: p.green_strength,
            green_lo: p.green_lo,
            green_hi: p.green_hi,
        },
    );
    let mut out = Vec::with_capacity(buf.len());
    for (i, px) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[px[0], px[1], px[2], buf[i * 4 + 3]]);
    }
    out
}

/// The slider spreads the gate sweeps: ACR's defaults at full and partial
/// strength, a widened purple band, a green-only pass, both families at
/// once, a degenerate band that must select nothing, the per-mask
/// hue-agnostic amount, and a mixture of the two.
fn cases() -> Vec<DefringeInputs> {
    let acr = |ps: f32, gs: f32| DefringeInputs {
        all_hues_strength: 0.0,
        purple_strength: ps,
        purple_lo: 30.0,
        purple_hi: 70.0,
        green_strength: gs,
        green_lo: 40.0,
        green_hi: 60.0,
    };
    vec![
        acr(1.0, 0.0),
        acr(0.25, 0.0),
        DefringeInputs {
            purple_lo: 0.0,
            purple_hi: 100.0,
            ..acr(0.75, 0.0)
        },
        DefringeInputs {
            green_lo: 20.0,
            green_hi: 90.0,
            ..acr(0.0, 1.0)
        },
        DefringeInputs {
            purple_lo: 20.0,
            purple_hi: 85.0,
            green_lo: 30.0,
            green_hi: 75.0,
            ..acr(0.6, 0.4)
        },
        DefringeInputs {
            purple_lo: 70.0,
            purple_hi: 30.0, // inverted — selects nothing
            ..acr(1.0, 0.0)
        },
        DefringeInputs::per_mask(100.0),
        DefringeInputs::per_mask(35.0),
        DefringeInputs {
            all_hues_strength: 0.25,
            ..acr(1.0, 0.0)
        },
    ]
}

/// THE PARITY GATE: the WGSL defringe kernel matches
/// `raw_core::stages::defringe::apply_params` — the actual Rust stage —
/// within 1e-4 across the slider spread, on a 2-D buffer spanning fringed
/// edges, flat interiors, out-of-band hues, neutrals, the luma floor, and
/// HDR values. The last three cases drive the PER-MASK inputs through the
/// same kernel, so the unified pass is gated on both callers here.
#[test]
fn wgsl_defringe_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_24x16();

    for inputs in cases() {
        let reference = raw_core_defringe(&input, w, h, &inputs);

        let img = GpuImage::upload(&ctx, &input, w, h);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&DefringePass { inputs }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!(
            "defringe parity: all_hues {:.2} purple {:.2}/{:.0}-{:.0} green {:.2}/{:.0}-{:.0} -> max |gpu - raw_core| = {max_diff:.3e}",
            inputs.all_hues_strength,
            inputs.purple_strength,
            inputs.purple_lo,
            inputs.purple_hi,
            inputs.green_strength,
            inputs.green_lo,
            inputs.green_hi,
        );
        assert!(
            max_diff < 1e-4,
            "GPU/raw-core divergence {max_diff} for {inputs:?}"
        );
    }
}

/// A disengaged pass is never built by the live chain, so the gate it uses
/// must agree with raw-core's own "is this engaged" predicate — for BOTH
/// callers' parameter shapes.
#[test]
fn the_engagement_gate_matches_raw_cores_predicate() {
    assert!(!DefringeInputs::default().is_engaged());
    assert!(!DefringeInputs::per_mask(0.0).is_engaged());
    assert!(
        raw_core::stages::defringe::params_from_values([0.0, 30.0, 70.0], [0.0, 40.0, 60.0])
            .is_none()
    );
    assert!(DefringeInputs::per_mask(1.0).is_engaged());
    assert!(DefringeInputs {
        purple_strength: 0.05,
        ..DefringeInputs::default()
    }
    .is_engaged());
    assert!(
        raw_core::stages::defringe::params_from_values([1.0, 30.0, 70.0], [0.0, 40.0, 60.0])
            .is_some()
    );
}

/// The per-mask constructor must produce exactly the normalisation
/// raw-core's does, or the two paths would disagree about strength.
#[test]
fn per_mask_normalisation_matches_raw_core() {
    for amount in [0.0_f32, 1.0, 37.5, 100.0, 250.0] {
        let mine = DefringeInputs::per_mask(amount);
        let theirs = raw_core::stages::defringe::DefringeParams::per_mask(amount);
        assert_eq!(
            mine.all_hues_strength, theirs.all_hues_strength,
            "at {amount}"
        );
        assert_eq!(mine.purple_strength, 0.0);
        assert_eq!(mine.green_strength, 0.0);
    }
}

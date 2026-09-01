#![cfg(test)]

//! End-to-end coverage for the DNG `FixVignetteRadial` opcode (#2243).
//!
//! Follow-up to #376: `FixVignetteRadial` (`OpcodeList3` id 3) parsing and
//! application had unit-test coverage only — hand-built opcode structs
//! multiplied directly onto a synthetic [`Image`], or (in
//! `develop_applies_opcode_list3_corrections` above) a `WarpRectilinear`
//! injected straight into `RawImage.opcode_list3` after decode, bypassing
//! the byte-level parser entirely. No RAW anywhere in `test-fixtures/raws/`
//! carries `FixVignetteRadial` (survey: only `test_0000.DNG` and
//! `test_0015.dng` have an `OpcodeList3` at all, and both carry
//! `WarpRectilinear` only), so nothing exercised DECODE → PARSE → DEVELOP
//! for this specific opcode. This lives here (a raw-core integration test)
//! rather than as a `test-fixtures/references/manifest.json` entry per the
//! ticket's explicit call: joining the color-parity harness would need an
//! ACR-rendered reference for a file ACR has never seen, which doesn't
//! exist and can't be manufactured.
//!
//! Ground truth: `grey_invariants.rs` already establishes that a flat
//! [`SyntheticGreyDng`] develops to a spatially FLAT scene-linear image at
//! `AdjustmentModel::default()` — every stage between demosaic and output
//! is either a no-op or a single GLOBAL scalar gain at default settings.
//! So attaching a `FixVignetteRadial` opcode and developing again isolates
//! its per-pixel gain exactly: the ratio of any two output pixels must
//! equal the ratio the closed form `1 + k0·t + k1·t² + k2·t³ + k3·t⁴ +
//! k4·t⁵` predicts for their `t` (squared center distance normalized so
//! `t = 1` at the farthest active-area corner) — independent of whatever
//! the develop chain's own global gain happens to be.

use super::*;
use crate::test_support::synth_dng::{fix_vignette_radial_opcode_list3, SyntheticGreyDng};

/// Same sign and rough magnitude as a real dng_sdk-authored correction:
/// darkens toward the edges (`k0 < 0`), never brightens past 1.0 (so the
/// opcode can't interact with highlight clipping/recovery downstream).
const K: [f64; 5] = [-0.35, -0.05, 0.0, 0.0, 0.0];
const CENTER: (f64, f64) = (0.5, 0.5);
const DIM: u32 = 64;

/// Independent re-derivation of `apply_fix_vignette_radial`'s closed form
/// (`pipeline::pano::opcode_apply::apply_fix_vignette_radial`) — NOT a
/// call into that function, so this test can catch a bug there rather
/// than only proving the function agrees with itself.
fn expected_gain(x: u32, y: u32) -> f64 {
    let (aa_w, aa_h) = (DIM as f64, DIM as f64);
    let cx = CENTER.0 * aa_w;
    let cy = CENTER.1 * aa_h;
    let norm_radius_sq = f64::hypot(cx.abs().max(aa_w - cx), cy.abs().max(aa_h - cy)).powi(2);
    let dx = x as f64 - cx;
    let dy = y as f64 - cy;
    let t = ((dx * dx + dy * dy) / norm_radius_sq).min(1.0);
    let poly = t * (K[0] + t * (K[1] + t * (K[2] + t * (K[3] + t * K[4]))));
    1.0 + poly
}

#[test]
fn fix_vignette_radial_opcode_parses_and_applies_end_to_end() {
    let opcode_list3 = fix_vignette_radial_opcode_list3(K, CENTER.0, CENTER.1);
    let dng = SyntheticGreyDng {
        linear_value: 0.18,
        width: DIM,
        height: DIM,
        opcode_list3: Some(opcode_list3),
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");

    // Parser round-trip: the opcode reached RawImage intact, through the
    // real byte-level parser (not a hand-built struct injected post-decode).
    let (list, _aa) = raw
        .opcode_list3
        .as_ref()
        .expect("OpcodeList3 must be present on the decoded RawImage");
    assert_eq!(list.opcodes.len(), 1, "expected exactly one opcode");
    match &list.opcodes[0] {
        crate::pipeline::pano::opcodes::PanoOpcode::FixVignetteRadial(op) => {
            assert_eq!(op.k, K);
            assert_eq!((op.center_x, op.center_y), CENTER);
        }
        other => panic!("expected FixVignetteRadial, got {other:?}"),
    }

    let model = AdjustmentModel::default();
    let scene = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("scene-linear render must succeed");

    let px = |x: u32, y: u32| -> [f32; 3] { scene.pixels[(y * DIM + x) as usize] };
    let center_val = px(DIM / 2, DIM / 2)[0] as f64;

    // Sample points spanning the radial profile: center, two mid-edges,
    // and a near-corner point. Strictly interior (never the literal
    // 0 / DIM-1 boundary) to avoid any residual demosaic edge handling.
    let samples: [(u32, u32); 5] = [
        (DIM / 2, DIM / 2),
        (DIM / 2, 2),
        (2, DIM / 2),
        (61, 32),
        (2, 2),
    ];
    for (x, y) in samples {
        let got_ratio = px(x, y)[0] as f64 / center_val;
        let want_ratio = expected_gain(x, y) / expected_gain(DIM / 2, DIM / 2);
        assert!(
            (got_ratio - want_ratio).abs() < 5e-3,
            "pixel ({x},{y}): ratio-to-center {got_ratio:.5}, closed-form predicts \
             {want_ratio:.5} (diff {:.5})",
            (got_ratio - want_ratio).abs()
        );

        // The opcode multiplies every channel identically, so hue must
        // survive: R == G == B at this pixel too, even off-center.
        let p = px(x, y);
        assert!(
            (p[0] - p[1]).abs() < 1e-3 && (p[0] - p[2]).abs() < 1e-3,
            "pixel ({x},{y}) not neutral under vignette: {:?}",
            p
        );
    }
}

//! The viewport entry must honor the same sensor correction as full develop.
use super::*;
use crate::{
    test_support::synth_dng::SyntheticGreyDng,
    types::adjustment::AutoLateralCa,
    xmp::{AutoExposureMode, HighlightRecoveryMode, Profile},
};

#[test]
fn sized_lateral_ca_corrects_before_demosaic_and_matches_full_without_resize() {
    let bytes = SyntheticGreyDng {
        width: 512,
        height: 384,
        as_shot_neutral_override: Some([1.0; 3]),
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    raw.black_level = [0; 4];
    raw.white_level = 60_000;
    raw.crop_rect = None;
    raw.baseline_exposure = 0.0;
    raw.raw_data = (0..512 * 384)
        .map(|i| {
            let (x, y) = (i % 512, i / 512);
            let color = raw.cfa.color_at(x, y);
            let (k, gain) = match color {
                0 => (0.003, 0.6),
                2 => (-0.002, 1.4),
                _ => (0.0, 1.0),
            };
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            let sx = fx + k * (fx - 256.0);
            let sy = fy + k * (fy - 192.0);
            let value = 0.5 + 0.15 * (sx * 0.41).sin() + 0.15 * (sy * 0.37).sin()
                - 0.12 * ((sx + sy) * 0.23).sin();
            (value * gain * 60_000.0).round() as u16
        })
        .collect();
    let off = AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        highlight_recovery: HighlightRecoveryMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..Default::default()
    };
    let on = AdjustmentModel {
        auto_lateral_ca: AutoLateralCa::On,
        ..off.clone()
    };
    let original = raw.raw_data.clone();
    for edge in [512, 128] {
        let sized = |model: &AdjustmentModel| {
            crate::pipeline::develop_scene_linear_sized_from_raw_with_quality(
                &raw,
                model,
                RenderQuality::Preview,
                edge,
            )
            .unwrap()
        };
        let baseline = sized(&off);
        let corrected = sized(&on);
        let max_delta = baseline
            .pixels
            .iter()
            .zip(&corrected.pixels)
            .flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs()))
            .fold(0.0_f32, f32::max);
        assert!(
            max_delta > 1e-3,
            "lateral CA ignored at edge {edge}: {max_delta}"
        );
        if edge == 512 {
            for (model, expected) in [(&off, baseline), (&on, corrected)] {
                let full =
                    develop_scene_linear_from_raw_with_quality(&raw, model, RenderQuality::Preview)
                        .unwrap();
                assert_eq!(expected.pixels, full.pixels);
            }
        }
    }
    assert_eq!(
        raw.raw_data, original,
        "sensor correction mutated the source"
    );

    // Vendor per-channel warp already owns CA correction. The sized path
    // must share the full path's provenance guard, rather than correct twice.
    use crate::pipeline::pano::opcodes::{
        ActiveAreaRect, OpcodeList3, PanoOpcode, WarpPlaneParams, WarpRectilinearOpcode,
    };
    raw.opcode_list3 = Some((
        OpcodeList3 {
            opcodes: vec![PanoOpcode::WarpRectilinear(WarpRectilinearOpcode {
                planes: [1.002, 1.0, 0.998]
                    .into_iter()
                    .map(|scale| WarpPlaneParams {
                        kr: [scale, 0.0, 0.0, 0.0],
                        kt: [0.0, 0.0],
                    })
                    .collect(),
                center_x: 0.5,
                center_y: 0.5,
            })],
            skipped_unknown: 0,
        },
        ActiveAreaRect::full(raw.width, raw.height),
    ));
    assert!(!raw.lens_correction_ca_inert());
    let render = |model: &AdjustmentModel| {
        crate::pipeline::develop_scene_linear_sized_from_raw_with_quality(
            &raw,
            model,
            RenderQuality::Preview,
            128,
        )
        .unwrap()
    };
    assert_eq!(
        render(&off).pixels,
        render(&on).pixels,
        "vendor CA was corrected twice"
    );
}

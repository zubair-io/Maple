//! #3633: shared highlight/OpcodeList3 preparation reaches the GPU unchanged.
use super::{assert_gpu_matches_cpu, gpu_available};
use raw_core::{
    test_support::synth_dng::{fix_vignette_radial_opcode_list3, SyntheticGreyDng},
    xmp::{AdjustmentModel, AutoExposureMode, HighlightRecoveryMode, Profile},
};

#[test]
fn highlight_recovery_and_unbounded_cubic_opcodes_match_cpu() {
    if !gpu_available() {
        eprintln!("opcode parity: no GPU adapter — skipping (soft pass)");
        return;
    }
    let mut opcodes = fix_vignette_radial_opcode_list3([1.0, 0.0, 0.0, 0.0, 0.0], 0.5, 0.5);
    opcodes[..4].copy_from_slice(&2u32.to_be_bytes());
    // DNG WarpRectilinear: id/version/flags/payload-size, one coefficient
    // plane, four radial and two tangential coefficients, optical center.
    for word in [1u32, 0x0103_0000, 0, 68, 1] {
        opcodes.extend_from_slice(&word.to_be_bytes());
    }
    for value in [0.93f64, 0.08, 0.0, 0.0, 0.0, 0.0, 0.5, 0.5] {
        opcodes.extend_from_slice(&value.to_be_bytes());
    }
    let bytes = SyntheticGreyDng {
        width: 64,
        height: 64,
        opcode_list3: Some(opcodes),
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode synthetic DNG");
    raw.black_level = [0; 4];
    raw.white_level = 4095;
    raw.as_shot_neutral = [0.6, 1.0, 0.8];
    raw.baseline_exposure = 0.75;
    // Keep the fixture read-only. Create a diagonal edge and a genuinely
    // saturated sensor stripe in memory, so warp taps see nonconstant color.
    for (i, value) in raw.raw_data.iter_mut().enumerate() {
        let (x, y) = (i as u32 % raw.width, i as u32 / raw.width);
        let channel = raw.cfa.color_at(x, y) as usize;
        let level = if (30..32).contains(&x) {
            1.0
        } else if x > y {
            0.8
        } else {
            0.2
        };
        let chroma = [0.6, 1.0, 0.8][channel];
        *value = (level * chroma * raw.white_level as f32).round() as u16;
    }
    assert!(
        raw.opcode_list3.is_some(),
        "synthetic lens opcodes must decode"
    );
    for mode in [
        HighlightRecoveryMode::Off,
        HighlightRecoveryMode::ChromaticAdaptation,
    ] {
        let model = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            profile: Profile::Neutral,
            highlight_recovery: mode,
            ..Default::default()
        };
        assert_gpu_matches_cpu(&format!("opcodes-{mode:?}"), &raw, &bytes, "dng", &model);
    }
    // The same shared preparation must respect physical sensor bounds on
    // both bindings, even when DefaultCrop is smaller than ActiveArea.
    let mut active = raw.opcode_list3.as_ref().unwrap().1;
    active.left = 8;
    active.top = 8;
    active.width = 48;
    active.height = 48;
    raw.lens_metadata.active_area = Some(active);
    raw.opcode_list3.as_mut().unwrap().1 = active;
    raw.crop_rect = Some(raw_core::image::CropRect {
        x: 10,
        y: 10,
        w: 44,
        h: 44,
    });
    for mode in [
        HighlightRecoveryMode::Off,
        HighlightRecoveryMode::ChromaticAdaptation,
    ] {
        let model = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            profile: Profile::Neutral,
            highlight_recovery: mode,
            ..Default::default()
        };
        assert_gpu_matches_cpu(
            &format!("active-area-opcodes-{mode:?}"),
            &raw,
            &bytes,
            "dng",
            &model,
        );
    }
    assert_guided_prefix_parity();
}

// #1690: positively exercise both guided tiers at the real CPU/GPU decode
// boundary. Keep the existing Bayer/warp/ActiveArea cases above unchanged.
fn assert_guided_prefix_parity() {
    use raw_core::{
        image::CfaPattern,
        linearize,
        stages::{highlight_recovery, white_balance},
    };

    for (edge, expected_green) in [(15u32, 1.4f32), (101, 1.6)] {
        let bytes = SyntheticGreyDng {
            width: 192,
            height: 192,
            ..Default::default()
        }
        .write_to_bytes();
        let mut raw =
            raw_core::decode::decode_bytes(&bytes, "dng").expect("guided synthetic decode");
        // Preserve genuine decoded DCP metadata, but isolate sensor recovery
        // from demosaic interpolation just like the core's bounds controls.
        raw.cfa = CfaPattern::LinearRgb;
        raw.white_level = 10_000;
        raw.black_level = [0; 4];
        raw.baseline_exposure = 0.0;
        raw.as_shot_neutral = [0.5, 1.0, 0.7];
        let start = 96 - edge / 2;
        raw.raw_data = (0..192u32 * 192)
            .flat_map(|i| {
                let (x, y) = (i % 192, i / 192);
                if (start..start + edge).contains(&x) && (start..start + edge).contains(&y) {
                    [9000u16, 10_000, 4200]
                } else {
                    [4500u16, 7000, 2100]
                }
            })
            .collect();

        let mut camera = linearize::linearraw_to_camera_rgb(&raw).expect("guided LinearRaw");
        white_balance::apply_pre_gain(&mut camera, raw.as_shot_neutral);
        let index = 96 * 192 + 96;
        let before = camera.pixels[index];
        // All 49 tier-1 neighbors are genuinely clipped in green. The 15px
        // block reaches regional cells; the 101px block needs the scene prior.
        for y in 93..=99 {
            for x in 93..=99 {
                assert!(camera.pixels[y * 192 + x][1] >= 0.995);
            }
        }
        highlight_recovery::apply(
            &mut camera,
            HighlightRecoveryMode::ChromaticAdaptation,
            raw.as_shot_neutral,
            raw.baseline_exposure,
        );
        let recovered = camera.pixels[index];
        assert_eq!(
            recovered[0].to_bits(),
            before[0].to_bits(),
            "known R changed"
        );
        assert_eq!(
            recovered[2].to_bits(),
            before[2].to_bits(),
            "known B changed"
        );
        assert!(
            (recovered[1] - expected_green).abs() < 0.01,
            "guided {edge}px center must engage its tier: {before:?} -> {recovered:?}"
        );

        let off = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            profile: Profile::Neutral,
            highlight_recovery: HighlightRecoveryMode::Off,
            ..Default::default()
        };
        let on = AdjustmentModel {
            highlight_recovery: HighlightRecoveryMode::ChromaticAdaptation,
            ..off.clone()
        };
        let (_, _, original) = super::cpu_reference(&raw, &bytes, "dng", &off);
        let (_, _, changed) = super::cpu_reference(&raw, &bytes, "dng", &on);
        assert_ne!(
            original, changed,
            "guided {edge}px must affect the rendered output"
        );
        for (mode, model) in [("off", off), ("on", on)] {
            assert_gpu_matches_cpu(
                &format!("guided-{edge}px-{mode}"),
                &raw,
                &bytes,
                "dng",
                &model,
            );
        }
    }
}

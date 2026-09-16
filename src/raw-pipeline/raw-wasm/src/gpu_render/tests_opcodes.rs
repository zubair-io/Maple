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
}

//! What the capture-first live chain builds (#5376): a white-balance tick
//! touches no capture-stage pass, and each creative pass owns its own
//! `active_mask` bit.

use super::tests::{neutral_case, TEST_SESSION_ID};
use super::tests_creative::{creative_inputs, creative_sink, custom, white_balances};
use super::*;
use crate::CaptureSharpeningParams;
use raw_core::pipeline::CreativeStage;
use raw_core::test_support::creative::{creative_stage, Tables};
use raw_core::xmp::HighlightRecoveryMode;

const CAPTURE_STAGE_PASSES: [&str; 5] = [
    "CaptureSharpening",
    "ChromaPrefilter",
    "Bm3d",
    "DeepDenoise",
    "Retouch",
];

fn engaged_capture_sharpening() -> CaptureSharpeningParams {
    CaptureSharpeningParams {
        sigma: 1.0,
        iterations: 2,
        highlight_threshold: 0.9,
        strength: 1.0,
        noise_floor: 3e-4,
    }
}

fn names_for(stage: &CreativeStage, model: &raw_core::xmp::AdjustmentModel) -> Vec<&'static str> {
    let wire = stage.gpu_wire();
    let plan = stage.gpu_plan(&wire, model).unwrap();
    let inputs = FullChainInputs {
        creative: Some(creative_inputs(&plan)),
        capture_sharpening: Some(engaged_capture_sharpening()),
        ..neutral_case().gpu_inputs()
    };
    let names = creative_sink(&inputs).names;
    names
}

fn is_creative(name: &str) -> bool {
    name.contains("Creative") || name.contains("PostDcpHighlight")
}

#[test]
fn a_white_balance_only_change_encodes_no_capture_stage_pass() {
    let stage = creative_stage(Tables::DualHueSatMapAndLook, 1.4);
    let baseline = names_for(&stage, &white_balances()[0]);
    assert!(
        baseline.iter().any(|n| n.contains("CreativeDcpPass")),
        "the creative stage must be in the chain: {baseline:?}"
    );
    let creative_free = |names: &[&'static str]| -> Vec<&'static str> {
        names.iter().copied().filter(|n| !is_creative(n)).collect()
    };
    for model in white_balances() {
        let names = names_for(&stage, &model);
        for capture_pass in CAPTURE_STAGE_PASSES {
            assert!(
                !names.iter().any(|n| n.contains(capture_pass)),
                "T={} tint={}: {capture_pass} encoded: {names:?}",
                model.temperature,
                model.tint
            );
        }
        assert_eq!(
            creative_free(&names),
            creative_free(&baseline),
            "a white-balance tick must change only creative passes"
        );
    }
}

#[test]
fn capture_sharpening_still_runs_in_the_chain_without_the_creative_stage() {
    let legacy = FullChainInputs {
        capture_sharpening: Some(engaged_capture_sharpening()),
        ..neutral_case().gpu_inputs()
    };
    assert!(
        creative_sink(&legacy)
            .names
            .iter()
            .any(|n| n.contains("CaptureSharpening")),
        "the test would pass vacuously if the legacy chain never ran the pass"
    );
}

#[test]
fn a_non_raw_buffer_ignores_the_creative_stage() {
    let stage = creative_stage(Tables::None, 1.0);
    let wire = stage.gpu_wire();
    let plan = stage.gpu_plan(&wire, &white_balances()[1]).unwrap();
    let inputs = FullChainInputs {
        creative: Some(creative_inputs(&plan)),
        input_shape: InputShape::LinearRec2020Fp16,
        wb_temperature: 5200.0,
        ..neutral_case().gpu_inputs()
    };
    let names = creative_sink(&inputs).names;
    assert!(!names.iter().any(|n| is_creative(n)), "{names:?}");
    assert!(names.iter().any(|n| n.contains("WhiteBalancePass")));
}

#[test]
fn each_creative_pass_owns_a_mask_bit_and_the_pool_key_follows_the_table_shape() {
    let signature = |inputs: &FullChainInputs| chain_signature(inputs, (8, 8), TEST_SESSION_ID);
    let build = |stage: &CreativeStage, model: &raw_core::xmp::AdjustmentModel| {
        let wire = stage.gpu_wire();
        let plan = stage.gpu_plan(&wire, model).unwrap();
        let inputs = FullChainInputs {
            creative: Some(creative_inputs(&plan)),
            ..neutral_case().gpu_inputs()
        };
        (signature(&inputs), active_mask(&inputs))
    };
    let stage = creative_stage(Tables::DualHueSatMap { srgb: false }, 1.0);
    let off = custom(3200.0, 0.0, HighlightRecoveryMode::Off);
    let recovered = custom(3200.0, 0.0, HighlightRecoveryMode::OklabChromaReduction);
    let (plain_sig, plain_mask) = build(&stage, &off);
    let (recovered_sig, recovered_mask) = build(&stage, &recovered);
    assert_eq!(recovered_mask ^ plain_mask, mask::bit::POST_DCP_HIGHLIGHT);
    assert_ne!(plain_sig, recovered_sig);
    assert_ne!(plain_mask & mask::bit::CREATIVE_DCP, 0);
    assert_eq!(plain_mask & mask::bit::CREATIVE_GAIN, 0);

    let boosted = creative_stage(Tables::DualHueSatMap { srgb: false }, 2.0);
    let (boosted_sig, boosted_mask) = build(&boosted, &off);
    assert_eq!(boosted_mask ^ plain_mask, mask::bit::CREATIVE_GAIN);
    assert_ne!(plain_sig, boosted_sig);

    let legacy = neutral_case().gpu_inputs();
    assert_eq!(active_mask(&legacy) & mask::bit::CREATIVE_DCP, 0);
    assert_ne!(signature(&legacy), plain_sig);

    let single = creative_stage(Tables::SingleHueSatMap, 1.0);
    let (single_sig, _) = build(&single, &off);
    assert_ne!(
        single_sig, plain_sig,
        "table sizes size the pooled bindings"
    );
}

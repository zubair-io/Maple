//! #4629: a LinearRaw DNG's declared OpcodeList2 transfer reaches the GPU
//! through the shared CPU preparation, at neutral and extreme WB — both where
//! it executes (high bit depth) and where 8-bit lossy holds it back (#5081).
use super::{assert_gpu_matches_cpu, gpu_available};
use raw_core::{
    test_support::{
        gain_map::{opcode_list, polynomial_entry},
        synth_dng::SyntheticGreyDng,
    },
    xmp::{AdjustmentModel, AutoExposureMode, Profile},
};

#[test]
fn declared_transfer_matches_cpu_at_neutral_and_extreme_white_balance() {
    if !gpu_available() {
        eprintln!("lossy DNG parity: no GPU adapter — skipping (soft pass)");
        return;
    }
    let curve = [0., 0.0625, 0., 0.9375];
    let bytes = SyntheticGreyDng {
        width: 64,
        height: 64,
        opcode_list2: Some(opcode_list(
            &[0, 1, 2].map(|plane| polynomial_entry([0, 0, 64, 64], plane, 1, &curve)),
        )),
        ..Default::default()
    }
    .write_to_bytes();
    let decoded = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode synthetic DNG");
    let cases = [(255u32, 1u32), (4095, 16)].map(|(white_level, scale)| {
        let mut raw = decoded.clone();
        raw.cfa = raw_core::CfaPattern::LinearRgb;
        raw.black_level = [0; 4];
        raw.white_level = white_level;
        raw.as_shot_neutral = [0.55, 1.0, 0.75];
        raw.raw_data = (0..64 * 64)
            .flat_map(|i| {
                let (x, y) = (i % 64, i / 64);
                [x * 4, 64 + y * 2, (x + y) * 2].map(|v| (v.min(255) * scale) as u16)
            })
            .collect();
        raw
    });
    let held_back = cases
        .each_ref()
        .map(|raw| raw.skipped_required_opcodes().len());
    assert_eq!(
        held_back,
        [3, 0],
        "8-bit holds the transfer back; 12-bit runs it"
    );
    for (raw, (temperature, tint)) in cases
        .iter()
        .flat_map(|raw| [(6500., 0.), (2000., 150.), (12000., -150.)].map(|wb| (raw, wb)))
    {
        let model = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            profile: Profile::Neutral,
            temperature,
            tint,
            temperature_seen: true,
            tint_seen: true,
            ..Default::default()
        };
        assert_gpu_matches_cpu(
            &format!("transfer-{}-{temperature}-{tint}", raw.white_level),
            raw,
            &bytes,
            "dng",
            &model,
        );
    }
}

/// The shared helper's budgets (≤ 2 LSB, < 5 % of bytes) at a sized edge,
/// since the GPU core caps physical frames.
const PHYSICAL_EDGE: u32 = 1024;

#[test]
#[ignore = "requires test-fixtures/raws/test_0006.DNG (gitignored); run with --ignored"]
fn physical_lossy_dng_matches_cpu_at_white_balance_extremes() {
    if !gpu_available() {
        eprintln!("lossy DNG parity: no GPU adapter — skipping (soft pass)");
        return;
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0006.DNG");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("lossy DNG parity: {} missing — skipping", path.display());
        return;
    };
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode test_0006");
    assert_eq!(
        raw.skipped_required_opcodes().len(),
        3,
        "test_0006 declares one required MapPolynomial per plane, held back (#5081)"
    );
    for (temperature, tint, seen) in [
        (6500., 0., false),
        (6500., 150., true),
        (6500., -150., true),
        (2000., 0., true),
        (12000., 0., true),
    ] {
        let model = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            profile: Profile::Neutral,
            temperature,
            tint,
            temperature_seen: seen,
            tint_seen: seen,
            ..Default::default()
        };
        let name = format!("test_0006-{temperature}-{tint}");
        let (cw, ch, cpu) = raw_core::pipeline::render_sized_from_raw_with_quality_and_source(
            &raw,
            &model,
            raw_core::pipeline::RenderQuality::Amaze,
            Some(raw_core::pipeline::RawInput::Bytes {
                bytes: &bytes,
                ext: "dng",
            }),
            PHYSICAL_EDGE,
        )
        .expect("CPU sized render");
        let (gw, gh, gpu) = pollster::block_on(super::super::render_gpu_core(
            &raw,
            &bytes,
            "dng",
            &model,
            Some(PHYSICAL_EDGE),
        ))
        .expect("GPU sized render");
        assert_eq!((cw, ch), (gw, gh), "[{name}] dims");
        let max_delta = cpu
            .iter()
            .zip(&gpu)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        let frac = cpu.iter().zip(&gpu).filter(|(a, b)| a != b).count() as f32 / cpu.len() as f32;
        eprintln!(
            "PARITY [{name}]: max byte delta {max_delta}, {:.3}% differ",
            frac * 100.
        );
        assert!(
            max_delta <= 2 && frac < 0.05,
            "[{name}] {max_delta} / {frac}"
        );
    }
}

//! Adapter-free actual Auto outcome coverage, separate from GPU pixel parity.
use raw_core::xmp::{AdjustmentModel, Profile};

#[test]
#[ignore = "requires physical RAW; explicit invocation fails if absent"]
fn actual_gpu_fit_status_physical_4096() {
    for (name, expected) in [("test_0007.DNG", true), ("test_0018.dng", false)] {
        let path = raw_core::test_support::fixtures::require_raw(name);
        let bytes = std::fs::read(&path).expect("physical RAW");
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("physical decode");
        let auto = AdjustmentModel::default();
        let (curve, _, _, status) =
            crate::gpu_render::fit_profile_artifacts_with_status(&raw, &bytes, "dng", &auto);
        assert_eq!(status, Some(expected), "{name}");
        if !expected {
            assert!(curve.is_empty(), "unavailable Auto must not invent a curve");
        }
        let neutral = AdjustmentModel {
            profile: Profile::Neutral,
            ..auto
        };
        let (curve, _, _, status) =
            crate::gpu_render::fit_profile_artifacts_with_status(&raw, &bytes, "dng", &neutral);
        assert_eq!(status, None);
        assert!(curve.is_empty(), "Neutral must carry no fitted curve");
        assert_eq!(std::fs::read(path).expect("original reread"), bytes);
    }
}

/// Absence is explicit, never substituted identity: Neutral and
/// unavailable-Auto yield an EMPTY curve flat + a size-0 LUT, so the GPU
/// composers omit the look passes (raw-core's `if let Some` skips). Uses the
/// committed synthetic DNG (no gitignored fixture); skips if it is absent.
#[test]
fn missing_fit_yields_absent_artifacts_not_identity() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .ancestors()
        .nth(3)
        .expect("CARGO_MANIFEST_DIR is not three levels below the repo root");
    let path = root.join("src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    if !path.exists() {
        eprintln!("missing_fit_yields_absent_artifacts: synthetic DNG absent — skipping");
        return;
    }
    let bytes = std::fs::read(&path).expect("read synthetic DNG");
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode synthetic DNG");
    // The synthetic grey DNG carries no embedded preview: Auto cannot fit.
    let auto = AdjustmentModel::default();
    let (curve, size, data, status) =
        crate::gpu_render::fit_profile_artifacts_with_status(&raw, &bytes, "dng", &auto);
    assert_eq!(
        status,
        Some(false),
        "preview-less Auto must report unavailable"
    );
    assert!(
        curve.is_empty(),
        "unavailable fit must leave the curve absent"
    );
    assert_eq!(size, 0, "unavailable fit must leave the LUT size 0");
    assert!(
        data.is_empty(),
        "unavailable fit must leave the LUT data empty"
    );
    let neutral = AdjustmentModel {
        profile: Profile::Neutral,
        ..auto
    };
    let (curve, size, data, status) =
        crate::gpu_render::fit_profile_artifacts_with_status(&raw, &bytes, "dng", &neutral);
    assert_eq!(status, None);
    assert!(curve.is_empty(), "Neutral must leave the curve absent");
    assert_eq!(size, 0, "Neutral must leave the LUT size 0");
    assert!(data.is_empty(), "Neutral must leave the LUT data empty");
}

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

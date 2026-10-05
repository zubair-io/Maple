//! Actual render outcomes and compatibility of the two public entry points (#4096).
use super::*;

fn qualify(name: &str, expected: bool) {
    let path = crate::test_support::fixtures::require_raw(name);
    let original = std::fs::read(&path).expect("physical fixture");
    let raw = crate::decode::decode_bytes(&original, "dng").expect("physical decode");
    let auto = AdjustmentModel::default();
    for source in [
        RawInput::Path(&path),
        RawInput::Bytes {
            bytes: &original,
            ext: "dng",
        },
    ] {
        let (w, h, rgb, fit) = render_from_raw_with_auto_fit(
            &raw,
            &auto,
            RenderQuality::Amaze,
            Some(source),
            Some(64),
            None,
        )
        .expect("actual Auto render");
        assert_eq!(fit, Some(expected), "{name}: actual artifacts outcome");
        let legacy = render_sized_from_raw_with_quality_and_source(
            &raw,
            &auto,
            RenderQuality::Amaze,
            Some(source),
            64,
        )
        .expect("legacy public entry");
        assert_eq!(
            (w, h, rgb),
            legacy,
            "both public entries must return the same frame"
        );
        let neutral = AdjustmentModel {
            profile: Profile::Neutral,
            ..auto.clone()
        };
        let (_, _, _, neutral_fit) = render_from_raw_with_auto_fit(
            &raw,
            &neutral,
            RenderQuality::Amaze,
            Some(source),
            Some(64),
            None,
        )
        .expect("Neutral render");
        assert_eq!(
            neutral_fit, None,
            "selected Neutral is not unavailable Auto"
        );
    }
    assert_eq!(std::fs::read(path).expect("original reread"), original);
}

#[test]
#[ignore = "requires physical RAW; explicit invocation fails if absent"]
fn actual_auto_status_active_physical_4096() {
    qualify("test_0007.DNG", true);
}

#[test]
#[ignore = "requires physical RAW; explicit invocation fails if absent"]
fn actual_auto_status_unavailable_physical_4096() {
    qualify("test_0018.dng", false);
}

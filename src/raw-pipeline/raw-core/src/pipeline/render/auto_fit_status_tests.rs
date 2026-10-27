//! Actual render outcomes and compatibility of the two public entry points (#4096).
use super::*;

fn qualify(name: &str, expected: AutoFitOutcome) {
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
    qualify("test_0007.DNG", AutoFitOutcome::Applied);
}

#[test]
#[ignore = "requires physical RAW; explicit invocation fails if absent"]
fn actual_auto_status_unavailable_physical_4096() {
    qualify("test_0018.dng", AutoFitOutcome::NoPreview);
}

/// #5458: the synthetic DNG carries no embedded preview, so Auto must report
/// exactly that, while a render with no RAW source cannot claim it.
#[test]
fn synthetic_preview_less_dng_reports_no_preview_5458() {
    use crate::test_support::synth_dng::SyntheticGreyDng;
    let bytes = SyntheticGreyDng::default().write_to_bytes();
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("synthetic decode");
    let auto = AdjustmentModel::default();
    let source = RawInput::Bytes {
        bytes: &bytes,
        ext: "dng",
    };
    let render = |source| {
        render_from_raw_with_auto_fit(&raw, &auto, RenderQuality::Preview, source, Some(64), None)
            .expect("synthetic render")
            .3
    };
    assert_eq!(render(Some(source)), Some(AutoFitOutcome::NoPreview));
    assert_eq!(render(None), Some(AutoFitOutcome::Unfitted));
    assert_eq!(
        fit_auto_profile_from_raw(&raw, &auto, RenderQuality::Preview, source).err(),
        Some(AutoFitOutcome::NoPreview)
    );
    let directory = tempfile::tempdir().expect("tempdir");
    let on_disk = directory.path().join("grey.dng");
    std::fs::write(&on_disk, &bytes).expect("write synthetic DNG");
    assert_eq!(
        render(Some(RawInput::Path(&on_disk))),
        Some(AutoFitOutcome::NoPreview)
    );
    let unreadable = directory.path().join("missing.dng");
    assert_eq!(
        render(Some(RawInput::Path(&unreadable))),
        Some(AutoFitOutcome::Unfitted),
        "a source that cannot be opened is a read failure, not a missing preview"
    );
    assert_eq!(
        fit_auto_profile_from_raw(
            &raw,
            &auto,
            RenderQuality::Preview,
            RawInput::Path(&unreadable)
        )
        .err(),
        Some(AutoFitOutcome::Unfitted)
    );
    let wire = [
        AutoFitOutcome::Applied,
        AutoFitOutcome::NoPreview,
        AutoFitOutcome::Unfitted,
    ]
    .map(AutoFitOutcome::as_str);
    assert_eq!(wire, ["applied", "no-preview", "unfitted"]);
}

/// A FIFO with no writer blocks on open, so any filesystem open here would hang.
#[cfg(unix)]
#[test]
fn available_fit_input_never_opens_the_source_5458() {
    let directory = tempfile::tempdir().expect("temp dir");
    let fifo = directory.path().join("blocking.dng");
    let made = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo");
    assert!(made.success());
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(auto_fit::unapplied_outcome(&RawInput::Path(&fifo), true));
    });
    assert_eq!(
        receiver.recv_timeout(std::time::Duration::from_secs(5)),
        Ok(AutoFitOutcome::Unfitted)
    );
}

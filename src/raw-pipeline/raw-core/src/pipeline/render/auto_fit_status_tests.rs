//! Actual render outcomes and compatibility of the two public entry points (#4096).
use super::*;
use crate::view::auto_profile::cache::CacheKey;

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

fn preview_less_raw() -> (Vec<u8>, RawImage) {
    let bytes = crate::test_support::synth_dng::SyntheticGreyDng::default().write_to_bytes();
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("synthetic decode");
    (bytes, raw)
}

fn render_outcome(raw: &RawImage, source: RawInput<'_>) -> Option<AutoFitOutcome> {
    let auto = AdjustmentModel::default();
    render_from_raw_with_auto_fit(
        raw,
        &auto,
        RenderQuality::Preview,
        Some(source),
        Some(64),
        None,
    )
    .expect("synthetic render")
    .3
}

fn render_key(raw: &RawImage, path: &std::path::Path) -> CacheKey {
    CacheKey::from_path(path, RenderQuality::Preview)
        .expect("stattable source")
        .with_origin(auto_fit::render_fit_origin(
            raw.width.max(raw.height),
            Some(64),
        ))
}

/// #5485: the first render of a preview-less source records the verdict under
/// the render's key, and a later render answers from it without opening the
/// source — a FIFO with no writer blocks on open, so any open would hang.
#[cfg(unix)]
#[test]
fn no_preview_verdict_is_cached_and_never_reopens_the_source_5485() {
    use crate::view::auto_profile::cache;
    let _guard = cache::test_lock();
    let (bytes, raw) = preview_less_raw();
    let directory = tempfile::tempdir().expect("temp dir");
    let on_disk = directory.path().join("grey.dng");
    std::fs::write(&on_disk, &bytes).expect("write synthetic DNG");
    assert!(!cache::has_no_preview(&render_key(&raw, &on_disk)));
    assert_eq!(
        render_outcome(&raw, RawInput::Path(&on_disk)),
        Some(AutoFitOutcome::NoPreview)
    );
    assert!(cache::has_no_preview(&render_key(&raw, &on_disk)));
    let bytes_key = CacheKey::from_bytes(&bytes, RenderQuality::Preview).with_origin(
        auto_fit::render_fit_origin(raw.width.max(raw.height), Some(64)),
    );
    render_outcome(
        &raw,
        RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        },
    );
    assert!(cache::has_no_preview(&bytes_key));

    let fifo = directory.path().join("blocking.dng");
    let made = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo");
    assert!(made.success());
    cache::insert_no_preview(render_key(&raw, &fifo));
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(render_outcome(&raw, RawInput::Path(&fifo)));
    });
    assert_eq!(
        receiver.recv_timeout(std::time::Duration::from_secs(10)),
        Ok(Some(AutoFitOutcome::NoPreview))
    );
}

/// #5485: a source that cannot be opened says nothing about its preview, so
/// it is not recorded — once it is readable again the same key is re-probed.
#[cfg(unix)]
#[test]
fn unreadable_source_is_not_cached_as_no_preview_5485() {
    use crate::view::auto_profile::cache;
    use std::os::unix::fs::PermissionsExt;
    let _guard = cache::test_lock();
    let (bytes, raw) = preview_less_raw();
    let directory = tempfile::tempdir().expect("temp dir");
    let on_disk = directory.path().join("locked.dng");
    std::fs::write(&on_disk, &bytes).expect("write synthetic DNG");
    let set_mode = |mode| {
        std::fs::set_permissions(&on_disk, std::fs::Permissions::from_mode(mode)).expect("chmod")
    };
    set_mode(0o000);
    if std::fs::File::open(&on_disk).is_ok() {
        set_mode(0o644);
        eprintln!("skipped: permissions do not deny reads for this user");
        return;
    }
    assert_eq!(
        render_outcome(&raw, RawInput::Path(&on_disk)),
        Some(AutoFitOutcome::Unfitted)
    );
    assert!(!cache::has_no_preview(&render_key(&raw, &on_disk)));
    set_mode(0o644);
    assert_eq!(
        render_outcome(&raw, RawInput::Path(&on_disk)),
        Some(AutoFitOutcome::NoPreview)
    );
    assert!(cache::has_no_preview(&render_key(&raw, &on_disk)));
}

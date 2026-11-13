use super::*;
use crate::view::auto_profile::cache;
use std::sync::atomic::AtomicBool;

fn source() -> RawImage {
    crate::decode::decode_bytes(
        include_bytes!("../../../../../../test-fixtures/removal/basic/source.dng"),
        "dng",
    )
    .unwrap()
}

#[test]
fn native_origin_hits_without_preview_io_and_ignores_live_grade() {
    let _lock = cache::test_lock();
    let raw = source();
    let bytes = b"1472-native-pair-not-a-raw";
    let key =
        CacheKey::from_bytes(bytes, RenderQuality::Amaze).with_origin(FitOrigin::Render(None));
    let mut residual = ColorLut::identity(3);
    residual.data[0] = 0.21;
    cache::insert(key.clone(), ProfileCurve::identity());
    cache::insert_lut(key, residual.clone());
    let standalone = CacheKey::from_bytes(bytes, RenderQuality::Amaze);
    let mut other = ColorLut::identity(3);
    other.data[0] = 0.77;
    cache::insert(standalone.clone(), ProfileCurve::identity());
    cache::insert_lut(standalone, other);
    let edited = AdjustmentModel {
        exposure: 4.0,
        contrast: 50.0,
        nr_color: 90.0,
        ..AdjustmentModel::default()
    };
    let actual = fit_native_auto_profile_cancellable(
        &raw,
        &edited,
        RenderQuality::Amaze,
        RawInput::Bytes { bytes, ext: "dng" },
        CancelToken::never(),
    )
    .unwrap();
    assert_eq!(
        actual,
        Some((Some(ProfileCurve::identity()), Some(residual)))
    );
    // No JPEG: another quality cannot borrow the native AMaZE result.
    assert!(fit_native_auto_profile_cancellable(
        &raw,
        &edited,
        RenderQuality::Preview,
        RawInput::Bytes { bytes, ext: "dng" },
        CancelToken::never()
    )
    .unwrap()
    .is_none());
}

#[test]
fn partial_native_cache_survives_unavailable_preview_like_full_render() {
    let _lock = cache::test_lock();
    let bytes = b"1472-native-partial-not-a-raw";
    let key = CacheKey::from_bytes(bytes, RenderQuality::Full).with_origin(FitOrigin::Render(None));
    cache::insert(key, ProfileCurve::identity());
    let actual = fit_native_auto_profile_cancellable(
        &source(),
        &AdjustmentModel::default(),
        RenderQuality::Full,
        RawInput::Bytes { bytes, ext: "dng" },
        CancelToken::never(),
    )
    .unwrap();
    assert_eq!(actual, Some((Some(ProfileCurve::identity()), None)));
}

#[test]
fn cancellation_wins_over_a_completed_native_cache() {
    let _lock = cache::test_lock();
    let bytes = b"1472-cancel-native-not-a-raw";
    let key = CacheKey::from_bytes(bytes, RenderQuality::Full).with_origin(FitOrigin::Render(None));
    cache::insert(key.clone(), ProfileCurve::identity());
    cache::insert_lut(key, ColorLut::identity(3));
    let flag = AtomicBool::new(true);
    let actual = fit_native_auto_profile_cancellable(
        &source(),
        &AdjustmentModel::default(),
        RenderQuality::Full,
        RawInput::Bytes { bytes, ext: "dng" },
        CancelToken::new(&flag),
    );
    assert!(matches!(actual, Err(Error::Cancelled)));
}

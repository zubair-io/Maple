//! Real render-size calibration parity and cache provenance (#4132).
use super::*;
use crate::view::auto_profile::cache;

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_cap_fit_matches_native_renderer_and_ignores_edits() {
    let _guard = cache::test_lock();
    let path = std::env::var_os("MAPLE_RENDER_FIT_TEST_RAW")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test-fixtures/raws/test_0017.dng")
        });
    let bytes = std::fs::read(&path).expect("real RAW fixture required with fixtures feature");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode RAW");
    let model = AdjustmentModel::default();
    let mut edited = model.clone();
    edited.exposure = 2.0;
    edited.temperature = 4200.0;
    edited.contrast = 40.0;
    let quality = RenderQuality::Preview;
    let identity = CacheKey::from_path(&path, quality).expect("fixture identity");
    let mut prior = None;
    cache::clear_for_test();
    cache::clear_lut_for_test();
    for edge in [1600, 4096] {
        let actual = fit_auto_profile_from_raw_at_cap(
            &raw,
            &edited,
            quality,
            RawInput::Path(&path),
            FitCap::Render(edge),
        )
        .expect("embedded JPEG fit");
        assert!(
            actual.0.is_some() && actual.1.is_some(),
            "both real fit stages required"
        );
        assert!(
            cache::get(&identity).is_none(),
            "render fit cannot poison standalone"
        );
        let key = identity
            .clone()
            .with_origin(render_fit_origin(raw.width.max(raw.height), Some(edge)));
        assert_eq!(actual.0, cache::get(&key));
        assert_eq!(actual.1, cache::get_lut(&key));
        assert_eq!(
            actual,
            fit_auto_profile_from_raw_at_cap(
                &raw,
                &model,
                quality,
                RawInput::Path(&path),
                FitCap::Render(edge)
            )
            .unwrap(),
            "warm caller-independent fit"
        );
        if let Some((previous_key, previous_fit)) = prior.take() {
            assert_eq!(
                (cache::get(&previous_key), cache::get_lut(&previous_key)),
                previous_fit,
                "other cap remains independent"
            );
            assert_ne!(
                actual, previous_fit,
                "fixture must distinguish cap artifacts"
            );
        }
        cache::clear_for_test();
        cache::clear_lut_for_test();
        crate::pipeline::render_sized_from_raw_with_quality_and_source(
            &raw,
            &model,
            quality,
            Some(RawInput::Path(&path)),
            edge,
        )
        .expect("cold native render");
        assert_eq!(
            actual.0,
            cache::get(&key),
            "cold native curve must match host fit"
        );
        assert_eq!(
            actual.1,
            cache::get_lut(&key),
            "cold native residual must match host fit"
        );
        prior = Some((key, actual));
    }
    assert!(fit_auto_profile_from_raw_at_cap(
        &raw,
        &model,
        quality,
        RawInput::Path(&path),
        FitCap::Render(0)
    )
    .is_none());
    cache::clear_for_test();
    cache::clear_lut_for_test();
}

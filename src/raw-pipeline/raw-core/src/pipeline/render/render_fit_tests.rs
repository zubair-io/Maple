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

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn display_p3_render_cannot_fit_the_shared_auto_tail_from_p3_pixels() {
    use crate::pipeline::{render_export_from_raw, ExportDepth, ExportPixels};
    use crate::view::encode::TargetPrimaries;
    let _guard = cache::test_lock();
    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("physical RAW");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode fixture");
    let model = AdjustmentModel::default();
    let source = || {
        Some(RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        })
    };
    let srgb = || {
        crate::pipeline::render_from_raw_with_auto_fit(
            &raw,
            &model,
            RenderQuality::Preview,
            source(),
            Some(768),
            None,
        )
        .expect("sRGB render")
    };
    let p3 = || match render_export_from_raw(
        &raw,
        &model,
        RenderQuality::Preview,
        source(),
        Some(768),
        TargetPrimaries::P3,
        ExportDepth::Eight,
    )
    .expect("P3 render")
    {
        (_, _, ExportPixels::Eight(pixels)) => pixels,
        _ => unreachable!("eight-bit export requested"),
    };
    let cold = || {
        cache::clear_for_test();
        cache::clear_lut_for_test();
    };
    cold();
    let srgb_cold = srgb();
    assert_eq!(srgb_cold.3, Some(true), "physical Auto fit must engage");
    let p3_after_srgb = p3();
    cold();
    let p3_cold = p3();
    let srgb_after_p3 = srgb();
    cold();
    let differing = |a: &[u8], b: &[u8]| a.iter().zip(b).filter(|(x, y)| x != y).count();
    assert_eq!(
        differing(&srgb_cold.2, &srgb_after_p3.2),
        0,
        "a P3-first render must not change the sRGB render's Auto fit"
    );
    assert_eq!(
        differing(&p3_cold, &p3_after_srgb),
        0,
        "a cold P3 render must fit the same Auto tail an sRGB render caches"
    );
    assert_eq!(std::fs::read(path).expect("original reread"), bytes);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn display_p3_default_render_applies_the_same_auto_tail_as_srgb() {
    use crate::view::encode::TargetPrimaries;
    let _guard = cache::test_lock();
    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("physical RAW");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode fixture");
    let model = AdjustmentModel::default();
    let quality = RenderQuality::Preview;
    cache::clear_for_test();
    cache::clear_lut_for_test();
    let (rendered, context) = super::super::render_display_scene_with_context(
        &raw,
        &model,
        quality,
        Some(RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        }),
        Some(768),
        TargetPrimaries::P3,
        None,
    )
    .expect("P3 render");
    cache::clear_for_test();
    cache::clear_lut_for_test();
    let lut = context.profile_lut.expect("physical residual fit");
    let mut expected =
        crate::pipeline::develop_sized::develop_scene_linear_sized_from_raw_with_quality(
            &raw,
            &fit_develop_model(&model),
            quality,
            768,
        )
        .expect("pinned develop");
    let full = (expected.width, expected.height);
    super::super::display_prefix::apply(
        &mut expected,
        &model,
        None,
        TargetPrimaries::P3,
        ((0, 0), full),
    );
    let curve_applies = auto_profile::apply_pipeline::auto1_enabled_by_env();
    let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut expected.pixels);
    if let Some(curve) = context.profile_curve.as_ref().filter(|_| curve_applies) {
        auto_profile::apply_curve(pixels, curve);
    }
    lut.apply_with_strength(pixels, auto_profile::lut::lut_strength_from_env());
    encode::gamut_guard_display_encoded_srgb(&mut expected);
    assert_eq!(
        rendered.pixels, expected.pixels,
        "a default-model P3 render must apply the tail exactly as the sRGB render route does"
    );
}

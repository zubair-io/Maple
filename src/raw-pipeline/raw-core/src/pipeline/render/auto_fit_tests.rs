//! Tests for the Auto Profile fit entry points (`auto_fit.rs`) — split into a
//! sibling file so `auto_fit.rs` stays under the 600-LOC hard budget. Test
//! contents were moved verbatim.

use super::*;

use super::*;

/// A caller model with every fit-relevant field deliberately non-default,
/// so anything leaking through `fit_develop_model` is unmissable.
fn heavily_edited_model() -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::On,
        exposure: 1.5,
        brightness: 30.0,
        contrast: 40.0,
        temperature: 4200.0,
        tint: -8.0,
        highlights: -60.0,
        shadows: 55.0,
        whites: 20.0,
        blacks: -20.0,
        vibrance: 25.0,
        saturation: -10.0,
        clarity: 35.0,
        texture: 15.0,
        dehaze: 12.0,
        nr_color: 80.0,
        nr_luminance: 17.0,
        sharpen_amount: 120.0,
        sharpen_radius: 2.5,
        capture_sharpening_amount: 65.0,
        profile: Profile::Auto,
        ..AdjustmentModel::default()
    }
}

/// #1085 contract (INVERTS the pre-#1085 pin, which asserted the caller's
/// exposure/WB/contrast SURVIVED into the fit model — that test encoded
/// the bug this ticket fixes): the fit model is the DEFAULT model with
/// only `auto_exposure: Off` pinned and the caller's `profile` carried.
/// No caller edit may leak into the fit develop, and the #972 high-freq
/// zeroing is gone — the fit runs the DEFAULT NR/sharpen, exactly like
/// the harness-gated CPU fit.
#[test]
fn fit_develop_model_pins_defaults_ignoring_caller_edits() {
    let model = heavily_edited_model();
    let fit = fit_develop_model(&model);

    // The whole-struct pin: default model + AE Off + profile carried.
    // Catches any future field addition leaking through too.
    let expected = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        profile: model.profile,
        ..AdjustmentModel::default()
    };
    assert_eq!(fit, expected, "fit model must be the AE-off default model");

    // Spot-assert the inversion explicitly so a regression reads clearly:
    // (a) caller edits do NOT survive (the #1085 bug had them surviving) …
    assert_eq!(fit.exposure, 0.0, "caller exposure must not reach the fit");
    assert_eq!(fit.contrast, 0.0, "caller contrast must not reach the fit");
    assert_eq!(fit.temperature, 6500.0, "caller WB must not reach the fit");
    // (b) … the #972 zeroing is REMOVED — defaults, not zeroes, so the fit
    //     input matches the harness-gated default-model CPU develop …
    assert_eq!(fit.nr_color, 25.0, "fit runs the DEFAULT nr_color");
    assert_eq!(fit.sharpen_amount, 40.0, "fit runs the DEFAULT sharpen");
    // (c) … AE stays pinned Off (#550/#871) and profile is carried.
    assert_eq!(fit.auto_exposure, AutoExposureMode::Off);
    assert_eq!(fit.profile, Profile::Auto);
}

/// #2035: the cache-only probe hits IFF both artifacts are cached under
/// the exact `(source, quality)` key, and returns exactly the cached
/// values. Pure in-memory (`CacheKey::from_bytes` on unique synthetic
/// byte strings — no file, structurally proving a hit needs no RAW
/// read), so no fixture and no cross-test cache interference.
#[test]
fn cached_fit_probe_hits_only_when_fully_cached() {
    use crate::view::auto_profile::cache;
    use crate::view::auto_profile::curve::ProfileCurve;

    let auto = AdjustmentModel::default();
    assert_eq!(auto.profile, Profile::Auto);
    let neutral = AdjustmentModel {
        profile: Profile::Neutral,
        ..AdjustmentModel::default()
    };

    // Cold key (never inserted) → miss.
    let cold = CacheKey::from_bytes(b"2035-probe-cold-unique-0001", RenderQuality::Preview);
    assert!(cached_auto_profile_fit(&auto, Some(&cold)).is_none());
    // No key at all (un-stattable path) → miss.
    assert!(cached_auto_profile_fit(&auto, None).is_none());

    // Curve alone → still a miss (the residual can't be told apart from
    // "never fit"; the develop must run).
    let half = CacheKey::from_bytes(b"2035-probe-curve-only-unique-0002", RenderQuality::Preview);
    cache::insert(half.clone(), ProfileCurve::identity());
    assert!(
        cached_auto_profile_fit(&auto, Some(&half)).is_none(),
        "a cached curve WITHOUT its paired LUT must not probe as a hit"
    );

    // Curve + LUT → hit, with exactly the cached artifacts.
    let full = CacheKey::from_bytes(b"2035-probe-full-unique-0003", RenderQuality::Preview);
    let mut lut = crate::view::auto_profile::lut::ColorLut::identity(5);
    lut.data[0] = 0.25; // recognisable tag
    cache::insert(full.clone(), ProfileCurve::identity());
    cache::insert_lut(full.clone(), lut.clone());
    let (curve, residual) =
        cached_auto_profile_fit(&auto, Some(&full)).expect("fully-cached key must hit");
    assert_eq!(curve, Some(ProfileCurve::identity()));
    assert_eq!(residual, Some(lut));

    // Not Profile::Auto → no tail regardless of cache state.
    assert!(
        cached_auto_profile_fit(&neutral, Some(&full)).is_none(),
        "non-Auto model must never probe as a hit"
    );

    // #2035 quality discriminant: the SAME bytes at a DIFFERENT quality
    // is a different key → miss (Preview-fit artifacts can't serve Full).
    let other_quality = CacheKey::from_bytes(b"2035-probe-full-unique-0003", RenderQuality::Full);
    assert!(
        cached_auto_profile_fit(&auto, Some(&other_quality)).is_none(),
        "a Preview-keyed fit must not serve a Full-quality probe"
    );
}

/// #1085 determinism: the fit develop — and therefore the fitted curve —
/// is IDENTICAL under different caller models. Compares the developed fit
/// buffers bit-for-bit, then the fitted curve coefficients exactly.
/// Bypasses the `auto_profile::cache` entirely (fits straight from the
/// buffers) so a cross-test cache hit can't mask a real divergence — the
/// pre-#1085 pitfall that kept this assertion untestable.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn fit_is_identical_under_different_caller_models() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0017.dng");
    if !path.exists() {
        return;
    }
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");

    let default_model = AdjustmentModel::default();
    let edited_model = heavily_edited_model();
    // Preview quality + sized develop keep the fixture test fast; the
    // pinned-model contract is quality/size-agnostic.
    let q = RenderQuality::Preview;
    let mle = Some(1024);
    let scene_a = develop_display_for_auto_fit(&raw, &default_model, q, mle)
        .expect("fit develop (default caller)");
    let scene_b = develop_display_for_auto_fit(&raw, &edited_model, q, mle)
        .expect("fit develop (edited caller)");
    assert_eq!(
        (scene_a.width, scene_a.height),
        (scene_b.width, scene_b.height)
    );
    assert_eq!(
        scene_a.pixels, scene_b.pixels,
        "the pinned fit develop must be BIT-identical regardless of the \
         caller's model — a difference means a caller field leaked into \
         the fit prefix (#1085)"
    );

    // And the fitted curve coefficients agree exactly (one shared
    // extraction so the preview can't be the variable).
    let preview = auto_profile::preview::extract_for_fit(&path).expect("test_0017 embedded JPEG");
    let (w, h) = (scene_a.width as usize, scene_a.height as usize);
    let fit = |scene: &Image| {
        auto_profile::fit_display::fit_curve_from_preview_display(
            preview.image.clone(),
            preview.color_space,
            bytemuck::cast_slice(&scene.pixels),
            w,
            h,
            raw.orientation,
        )
        .expect("curve fit")
    };
    let curve_a = fit(&scene_a);
    let curve_b = fit(&scene_b);
    assert_eq!(
        curve_a, curve_b,
        "fitted curves must be coefficient-identical under different \
         caller models (#1085)"
    );
}

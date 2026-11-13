//! #1472: prepare the exact uncapped Auto tail used by full render/export.
//! Kept separate from the standalone proxy entry: neither cache can serve the
//! other's artifacts. Apple preparation runs this off its GPU submission actor.
use super::{
    auto_fit::{
        cached_auto_profile_fit, develop_display_for_auto_fit_cancellable, extract_preview_for_fit,
    },
    RawInput,
};
use crate::{
    cancel::CancelToken,
    error::{Error, Result},
    image::RawImage,
    pipeline::RenderQuality,
    types::adjustment::Profile,
    view::auto_profile::{
        self,
        cache::{CacheKey, FitOrigin},
        curve::ProfileCurve,
        lut::ColorLut,
    },
    xmp::AdjustmentModel,
};

pub fn fit_native_auto_profile_cancellable(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: RawInput<'_>,
    cancel: CancelToken<'_>,
) -> Result<Option<(Option<ProfileCurve>, Option<ColorLut>)>> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if model.profile != Profile::Auto {
        return Ok(None);
    }
    let key = match &raw_source {
        RawInput::Path(path) => CacheKey::from_path(path, quality),
        RawInput::Bytes { bytes, .. } => Some(CacheKey::from_bytes(bytes, quality)),
    }
    .map(|key| key.with_origin(FitOrigin::Render(None)));
    if let Some(pair) = cached_auto_profile_fit(model, key.as_ref()) {
        return if cancel.is_cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(Some(pair))
        };
    }
    let cached_curve = key.as_ref().and_then(auto_profile::cache::get);
    let cached_lut = if auto_profile::lut::lut_disabled_by_env() {
        None
    } else {
        key.as_ref().and_then(auto_profile::cache::get_lut)
    };
    let Some(preview) = extract_preview_for_fit(&raw_source) else {
        return finish((cached_curve, cached_lut), cancel);
    };
    let mut scene = develop_display_for_auto_fit_cancellable(raw, model, quality, None, cancel)?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let (w, h) = (scene.width as usize, scene.height as usize);
    // Publish only after the solver completes and cancellation is checked.
    // The existing curve/residual LRUs remain separate, as in full rendering.
    let pair = auto_profile::apply_pipeline::fit_auto_profile_artifacts(
        bytemuck::cast_slice_mut(&mut scene.pixels),
        w,
        h,
        raw.orientation,
        Some(&preview),
        None,
        cached_curve,
        cached_lut,
    );
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if let RawInput::Path(path) = raw_source {
        let current =
            CacheKey::from_path(path, quality).map(|key| key.with_origin(FitOrigin::Render(None)));
        if current != key {
            return Err(Error::Pipeline(
                "native Auto source changed during preparation".into(),
            ));
        }
    }
    if let Some(key) = key {
        if let Some(curve) = pair.0.as_ref() {
            auto_profile::cache::insert(key.clone(), curve.clone());
        }
        if let Some(lut) = pair.1.as_ref() {
            auto_profile::cache::insert_lut(key, lut.clone());
        }
    }
    finish(pair, cancel)
}

fn finish(
    pair: (Option<ProfileCurve>, Option<ColorLut>),
    cancel: CancelToken<'_>,
) -> Result<Option<(Option<ProfileCurve>, Option<ColorLut>)>> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if pair.0.is_none() && pair.1.is_none() {
        return Ok(None);
    }
    let strength = auto_profile::lut::lut_strength_from_env();
    let residual = if strength == 1.0 {
        pair.1
    } else {
        pair.1.map(|lut| lut.with_strength(strength))
    };
    Ok(Some((pair.0, residual)))
}

#[cfg(test)]
#[path = "auto_fit_native_tests.rs"]
mod tests;

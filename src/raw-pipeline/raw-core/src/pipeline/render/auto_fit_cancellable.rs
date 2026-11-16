use super::*;

/// Cancellable variant of [`fit_auto_profile_from_raw_at_cap`]. Existing
/// callers retain their ABI and non-cancellable behavior through the wrapper.
pub fn fit_auto_profile_from_raw_at_cap_cancellable(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: RawInput<'_>,
    cap: FitCap,
    cancel: CancelToken<'_>,
) -> std::result::Result<FitArtifacts, AutoFitOutcome> {
    if cancel.is_cancelled() {
        return Err(AutoFitOutcome::Cancelled);
    }
    if model.profile != Profile::Auto || cap == FitCap::Render(0) {
        return Err(AutoFitOutcome::Unfitted);
    }
    let auto_cache_key = match (cap, &raw_source) {
        (FitCap::Native, _) => None,
        (_, RawInput::Path(p)) => CacheKey::from_path(p, quality),
        (_, RawInput::Bytes { bytes, .. }) => Some(CacheKey::from_bytes(bytes, quality)),
    }
    .map(|key| match cap {
        FitCap::Render(edge) => {
            key.with_origin(render_fit_origin(raw.width.max(raw.height), Some(edge)))
        }
        _ => key,
    });

    if let Some(pair) = cached_auto_profile_fit(model, auto_cache_key.as_ref()) {
        return Ok(pair);
    }

    let lut_disabled = auto_profile::lut::lut_disabled_by_env();
    let cached_curve = auto_cache_key.as_ref().and_then(auto_profile::cache::get);
    let cached_lut = if lut_disabled {
        None
    } else {
        auto_cache_key
            .as_ref()
            .and_then(auto_profile::cache::get_lut)
    };

    let preview = preview_for_fit(&raw_source, auto_cache_key.as_ref());
    let missing_preview = preview.as_ref().err().copied();
    let (curve, residual) = match preview {
        Err(_) => (cached_curve, cached_lut),
        Ok(preview) => {
            let mle = match cap {
                FitCap::Proxy => Some(auto_fit_max_long_edge(&preview)),
                FitCap::Native => None,
                FitCap::Render(edge) => Some(edge),
            };
            let shrink_to = mle.filter(|_| cap == FitCap::Proxy);
            let (pinned, preview) = fit_model_and_preview(model, raw, preview, shrink_to);
            let mut scene =
                develop_display_for_auto_fit_cancellable(raw, &pinned, quality, mle, cancel)
                    .map_err(|e| {
                        if matches!(e, Error::Cancelled) {
                            AutoFitOutcome::Cancelled
                        } else {
                            AutoFitOutcome::Unfitted
                        }
                    })?;
            if cancel.is_cancelled() {
                return Err(AutoFitOutcome::Cancelled);
            }
            let (w, h) = (scene.width as usize, scene.height as usize);
            let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
            auto_profile::apply_pipeline::fit_auto_profile_artifacts_cancellable(
                pixels,
                w,
                h,
                raw.orientation,
                Some(&preview),
                auto_cache_key.as_ref(),
                cached_curve,
                cached_lut,
                cancel,
            )
            .map_err(|e| {
                if matches!(e, Error::Cancelled) {
                    AutoFitOutcome::Cancelled
                } else {
                    AutoFitOutcome::Unfitted
                }
            })?
        }
    };

    let curve = render_curve(curve);
    if curve.is_none() && residual.is_none() {
        return Err(missing_preview.unwrap_or(AutoFitOutcome::Unfitted));
    }
    let k = auto_profile::lut::lut_strength_from_env();
    let residual = if k == 1.0 {
        residual
    } else {
        residual.map(|l| l.with_strength(k))
    };
    Ok((curve, residual))
}

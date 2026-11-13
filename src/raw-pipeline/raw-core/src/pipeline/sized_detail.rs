//! Shared sized-preview detail stages, after the retained pre-detail scene.
//! #4352: the legacy develop and resident CPU preview use identical kernels/order.
use super::{dump_after, stage};
use crate::{
    cancel::CancelToken,
    error::{Error, Result},
    image::{Image, RawImage},
    stages::{noise_reduction, sharpen},
    xmp::AdjustmentModel,
};

pub(super) fn apply(
    scene: &mut Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    cancel: CancelToken<'_>,
) -> Result<()> {
    stage("sized_sharpen", || {
        let radius = sharpen::radius_at_scale(model.sharpen_radius, scene.nr_sampling_scale);
        sharpen::apply_cancellable(
            scene,
            model.sharpen_amount,
            radius,
            model.sharpen_detail,
            model.sharpen_masking,
            cancel,
        )
    });
    dump_after("13_sharpen", scene);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    stage("sized_nr_luminance", || {
        noise_reduction::apply_luminance_cancellable(
            scene,
            model.nr_luminance,
            cancel,
            raw.noise_profile.as_deref(),
            raw.iso,
        )
    });
    dump_after("14_nr_luminance", scene);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let nr_sampling_scale = scene.nr_sampling_scale;
    stage("sized_nr_color", || {
        noise_reduction::apply_color_sampled_cancellable(
            scene,
            model.nr_color,
            cancel,
            raw.noise_profile.as_deref(),
            raw.iso,
            nr_sampling_scale,
        )
    });
    dump_after("15_nr_color", scene);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(())
}

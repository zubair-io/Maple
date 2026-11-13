//! The chain's dehaze stage and the full-frame haze maps a window needs
//! (#3287). A whole buffer measures its own maps; a native-detail window is
//! handed the maps of the frame it sits in, so its recovery is the whole
//! frame's recovery restricted to the window.

use super::{f32_chain::apply_pre_dehaze, ChainOptions, ChainWindow};
use crate::{
    error::{Error, Result},
    stages::{
        defringe,
        dehaze::{self, FrameHaze, HazeMap},
        local_adjustments,
    },
    xmp::AdjustmentModel,
};

/// The global stage. A window's maps were checked by the windowed entry.
pub(super) fn dehaze(
    img: &mut crate::image::Image,
    amount: f32,
    haze: Option<&FrameHaze>,
    window: Option<ChainWindow>,
) -> Result<()> {
    let map = haze.and_then(|haze| haze.global.as_ref());
    match (window, map) {
        (None, _) => dehaze::apply_whole_frame(img, amount, haze),
        (Some(w), Some(map)) => dehaze::apply_with_map(
            img,
            amount,
            map,
            (w.x as i32, w.y as i32),
            (w.full_width, w.full_height),
        ),
        (Some(_), None) if dehaze::engaged(amount) => return Err(missing_map()),
        (Some(_), None) => {}
    }
    Ok(())
}

pub(super) fn missing_map() -> Error {
    Error::Pipeline("native detail with dehaze needs the full frame's haze map".into())
}

/// The haze maps the per-tick chain measures for `model` on this whole
/// frame (`frame_rgba`, f32 RGBA): hand it the same decoded scene-linear
/// buffer, at the same resolution, the whole-image chain is fed, and the
/// maps equal the ones that chain measures. `None` when dehaze is off
/// everywhere. Hand them to a windowed render of the same frame through
/// [`ChainOptions::haze_map`]; they stay valid while `model` changes only in
/// dehaze amounts no downstream map depends on (see `dehaze::haze_key`) or in
/// stages after the ones they were measured at.
pub fn scene_linear_chain_haze_map(
    frame_rgba: &[f32],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    options: &ChainOptions<'_>,
) -> Result<Option<FrameHaze>> {
    scene_linear_chain_haze_map_cancellable(
        frame_rgba,
        width,
        height,
        model,
        options,
        crate::CancelToken::never(),
    )
}

pub fn scene_linear_chain_haze_map_cancellable(
    frame_rgba: &[f32],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    options: &ChainOptions<'_>,
    cancel: crate::CancelToken<'_>,
) -> Result<Option<FrameHaze>> {
    if !dehaze::any_engaged(model) {
        return Ok(None);
    }
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4));
    if width == 0 || height == 0 || expected != Some(frame_rgba.len()) {
        return Err(Error::Pipeline(format!(
            "haze map: frame buffer of {} floats does not hold {width}x{height} RGBA",
            frame_rgba.len()
        )));
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    // The frame buffer is the whole frame, so the S/H mask sizes from it.
    let whole = ChainOptions {
        mask_long_edge: None,
        haze_map: None,
        ..*options
    };
    // The prefix runs at the frame's own resolution, exactly as the
    // whole-frame chain runs it: tone curves, clarity and texture do not
    // commute with the proxy's downsample, so measuring after a smaller
    // prefix would hand a window another frame's map.
    let mut img = crate::image::Image {
        whites_anchor_ev: options.whites_anchor_ev,
        nr_sampling_scale: options.nr_sampling_scale,
        ..super::endcaps::unpack_f32(frame_rgba, width, height)
    };
    apply_pre_dehaze(&mut img, model, &whole, cancel)?;
    let global = dehaze::engaged(model.dehaze).then(|| HazeMap::measure(&img));
    if !local_adjustments::spatial::any_dehaze_engaged(&model.local_adjustments) {
        return Ok(Some(FrameHaze {
            global,
            layers: Vec::new(),
        }));
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if let Some(map) = &global {
        let frame = (img.width, img.height);
        dehaze::apply_with_map(&mut img, model.dehaze, map, (0, 0), frame);
    }
    defringe::apply_model(&mut img, model);
    let layers = local_adjustments::apply_measuring_haze(
        &mut img,
        &model.local_adjustments,
        &model.mask_rasters,
    );
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(Some(FrameHaze { global, layers }))
}

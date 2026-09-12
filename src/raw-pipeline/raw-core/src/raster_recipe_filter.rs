//! Filter recipe-op glue (#3504 task E4): wires `blur`, `sharpen`, `median`,
//! `threshold` and `convolve` from `raster_recipe::Op` into the
//! `RasterImage` methods `raster_filter`/`raster_filter_ops`/`raster_sharpen`
//! already provide. Split out of `raster_recipe_exec.rs` purely to stay
//! under this crate's 400-line soft file-size budget — the same reason
//! `raster_filter_ops.rs` was split out of `raster_filter.rs` at the
//! `RasterImage` layer. `raster_recipe_exec::apply_op` tries
//! [`apply_filter_op`] first and falls through to its own match for every
//! other op.

use crate::error::Result;
use crate::raster::RasterImage;
use crate::raster_recipe::Op;
use crate::raster_sharpen::SharpenOptions;

/// Apply `op` if it's one of the five filter ops this file owns, returning
/// `None` for anything else so `apply_op` can fall through to its own
/// match.
///
/// `Convolve`'s `scale` is where sharp's wire semantics and
/// `RasterImage::convolve`'s own contract disagree, and this is the one
/// place that reconciles them: `RasterImage::convolve` treats a literal
/// `0.0` as its own "use the kernel's sum" sentinel, but sharp's real API
/// only falls back to the kernel sum when the caller omits `scale`
/// entirely — an explicit `scale: 0` (or any non-positive value) is clipped
/// to a minimum of `1.0`. `Op::Convolve.scale` is `Option<f64>` precisely so
/// this function can tell the two apart: `None` (absent) is passed straight
/// through as raw-core's `0.0` sentinel, `Some(v)` (explicit, sharp's rules)
/// is clamped to `v.max(1.0)` first. See `Op::Convolve`'s doc comment in
/// `raster_recipe.rs` for the wire-level rationale.
pub(crate) fn apply_filter_op(image: &RasterImage, op: &Op) -> Option<Result<RasterImage>> {
    match op {
        Op::Blur { sigma } => Some(image.blur(*sigma)),
        Op::Sharpen {
            sigma,
            m1,
            m2,
            x1,
            y2,
            y3,
        } => Some(image.sharpen(&SharpenOptions {
            sigma: *sigma,
            m1: *m1,
            m2: *m2,
            x1: *x1,
            y2: *y2,
            y3: *y3,
        })),
        Op::Median { size } => Some(image.median(*size)),
        Op::Threshold { value, greyscale } => Some(Ok(image.threshold(*value, *greyscale))),
        Op::Convolve {
            width,
            height,
            kernel,
            scale,
            offset,
        } => {
            let resolved_scale = scale.map_or(0.0, |s| s.max(1.0));
            Some(image.convolve(*width, *height, kernel, resolved_scale, *offset))
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "raster_recipe_filter_tests.rs"]
mod tests;

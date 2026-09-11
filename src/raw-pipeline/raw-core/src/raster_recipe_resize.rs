//! Resize op execution for the recipe pipeline: wire-string parsing for
//! `fit`/`kernel`/`position` plus the `Op::Resize` executor arm. Split out of
//! `raster_recipe_exec.rs` (#3502 C5) to keep that file inside the repo's
//! file-size budget — `apply_op`'s match arm delegates to `apply_resize_op`
//! here rather than duplicating the dispatch; no behaviour change.

use crate::error::Result;
use crate::raster::{resize_raster, FilterAlg, RasterImage, ResizeFit, ResizeOptions};
use crate::raster_composite::Gravity;
use crate::raster_recipe_exec::bad;

pub(crate) fn fit_from_wire(s: &str) -> Result<ResizeFit> {
    match s {
        "cover" => Ok(ResizeFit::Cover),
        "contain" => Ok(ResizeFit::Contain),
        "fill" => Ok(ResizeFit::Fill),
        "inside" => Ok(ResizeFit::Inside),
        "outside" => Ok(ResizeFit::Outside),
        other => Err(bad(format!("unsupported resize fit '{other}'"))),
    }
}

pub(crate) fn kernel_from_wire(s: &str) -> Result<FilterAlg> {
    match s {
        "lanczos3" => Ok(FilterAlg::Lanczos3),
        "lanczos2" => Ok(FilterAlg::Lanczos2),
        "cubic" => Ok(FilterAlg::CatmullRom),
        "mitchell" => Ok(FilterAlg::Mitchell),
        // `bilinear` is Maple's Tier 1 spelling; `linear` is sharp's.
        "linear" | "bilinear" => Ok(FilterAlg::Bilinear),
        "nearest" => Ok(FilterAlg::Nearest),
        other => Err(bad(format!(
            "unsupported resize kernel '{other}' (nearest, linear, cubic, mitchell, lanczos2, lanczos3)"
        ))),
    }
}

/// Execute the recipe's `resize` op: parse the wire strings (`fit`, `kernel`,
/// `position`), then delegate to `resize_raster`. Called from
/// `raster_recipe_exec::apply_op`'s `Op::Resize` match arm.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_resize_op(
    image: &RasterImage,
    width: u32,
    height: u32,
    fit: &str,
    position: &str,
    kernel: &str,
    without_enlargement: bool,
    without_reduction: bool,
    background: [u8; 4],
) -> Result<RasterImage> {
    resize_raster(
        image,
        &ResizeOptions {
            width,
            height,
            fit: fit_from_wire(fit)?,
            filter: kernel_from_wire(kernel)?,
            without_enlargement,
            without_reduction,
            position: Gravity::from_wire(position).ok_or_else(|| {
                bad(format!(
                    "unsupported resize position '{position}' \
                     (the entropy and attention strategies are not implemented)"
                ))
            })?,
            background,
        },
    )
}

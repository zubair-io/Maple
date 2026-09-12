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

/// The `resize` op's wire fields, borrowed straight off the parsed recipe.
///
/// A named struct rather than nine positional arguments: `fit`, `position`
/// and `kernel` are all `&str`, so passing them positionally lets any two
/// be transposed at the call site without the compiler noticing — and a
/// transposed pair fails at runtime with a confusing "unsupported resize
/// fit 'centre'" rather than at compile time.
pub(crate) struct ResizeOpArgs<'a> {
    pub width: u32,
    pub height: u32,
    pub fit: &'a str,
    pub position: &'a str,
    pub kernel: &'a str,
    pub without_enlargement: bool,
    pub without_reduction: bool,
    pub background: [u8; 4],
}

/// Execute the recipe's `resize` op: parse the wire strings (`fit`, `kernel`,
/// `position`), then delegate to `resize_raster`. Called from
/// `raster_recipe_exec::apply_op`'s `Op::Resize` match arm.
pub(crate) fn apply_resize_op(image: &RasterImage, args: &ResizeOpArgs<'_>) -> Result<RasterImage> {
    let position = Gravity::from_wire(args.position).ok_or_else(|| {
        bad(format!(
            "unsupported resize position '{}' \
             (the entropy and attention strategies are not implemented)",
            args.position
        ))
    })?;
    resize_raster(
        image,
        &ResizeOptions {
            width: args.width,
            height: args.height,
            fit: fit_from_wire(args.fit)?,
            filter: kernel_from_wire(args.kernel)?,
            without_enlargement: args.without_enlargement,
            without_reduction: args.without_reduction,
            position,
            background: args.background,
        },
    )
}

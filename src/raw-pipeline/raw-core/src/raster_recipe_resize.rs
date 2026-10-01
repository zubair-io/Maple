//! Wire validation for raster recipe resize options.

use crate::error::Result;
use crate::raster::{FilterAlg, ResizeFit, ResizeOptions};
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

pub(crate) fn options_from_wire(op: &crate::raster_recipe::Op) -> Result<ResizeOptions> {
    let crate::raster_recipe::Op::Resize {
        width,
        height,
        fit,
        position,
        kernel,
        without_enlargement,
        without_reduction,
        background,
    } = op
    else {
        return Err(bad(format!("{op:?} is not a resize op")));
    };
    let position = Gravity::from_wire(position).ok_or_else(|| {
        bad(format!("unsupported resize position '{position}' (the entropy and attention strategies are not implemented)"))
    })?;
    Ok(ResizeOptions {
        width: *width,
        height: *height,
        fit: fit_from_wire(fit)?,
        filter: kernel_from_wire(kernel)?,
        without_enlargement: *without_enlargement,
        without_reduction: *without_reduction,
        position,
        background: *background,
    })
}

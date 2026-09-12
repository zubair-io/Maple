//! Filter recipe-op glue (#3504 task E4): wires `blur`, `sharpen`, `median`,
//! `threshold` and `convolve` from `raster_recipe::Op` into the
//! `RasterImage` methods `raster_filter`/`raster_filter_ops`/`raster_sharpen`
//! already provide. Split out of `raster_recipe_exec.rs` purely to stay
//! under this crate's 400-line soft file-size budget — the same reason
//! `raster_filter_ops.rs` was split out of `raster_filter.rs` at the
//! `RasterImage` layer. `raster_recipe_exec::apply_op` tries
//! [`apply_filter_op`] first and falls through to its own match for every
//! other op.
//!
//! **The five wire structs below** (`BlurOp`/`SharpenOp`/`MedianOp`/
//! `ThresholdOp`/`ConvolveOp`) used to be inline struct-like fields on
//! `raster_recipe::Op`'s own variants. #3504 task E5 controller ruling (d)
//! moved them here — and `Op`'s variants to the matching newtype form,
//! `Blur(BlurOp)` rather than `Blur { sigma }` — specifically to bring
//! `raster_recipe.rs` back under its 400-line soft budget once this task's
//! other three rulings (a-c) added lines there and here; `raster_recipe.rs`
//! re-exports nothing itself, it just imports these by name so `Op`'s
//! definition compiles. Serde's internally-tagged representation
//! (`#[serde(tag = "op")]`) supports newtype variants exactly like this
//! whenever the newtype's inner type deserializes from a map, which every
//! one of these five does (`#[serde(deny_unknown_fields)]` structs are
//! trivially map-shaped) — so the wire format is byte-for-byte unchanged;
//! only where the Rust field lists live moved.

use crate::error::Result;
use crate::raster::RasterImage;
use crate::raster_recipe::{one, ten, yes, Op};
use crate::raster_sharpen::SharpenOptions;
use serde::Deserialize;

fn two() -> f64 {
    2.0
}
fn twenty() -> f64 {
    20.0
}
fn three() -> u32 {
    3
}
fn one_two_eight() -> u8 {
    128
}

/// Wire shape for `Op::Blur`. `sigma: null` (the wire default, and the
/// absent case) is sharp's fast 3x3 box blur (`RasterImage::blur`'s `None`
/// case); `sigma` present is a Gaussian. sharp's `precision` option is
/// deliberately NOT part of this schema (`deny_unknown_fields` rejects it
/// by name) — Maple's blur has no separate integer/float precision knob to
/// select.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlurOp {
    #[serde(default)]
    pub sigma: Option<f64>,
}

/// Wire shape for `Op::Sharpen`. `sigma: null` runs sharp's fast,
/// argument-less `sharpen()` kernel; `sigma` present runs the mask-based
/// Lab unsharp transfer with `m1`/`m2`/`x1`/`y2`/`y3` (see
/// [`SharpenOptions`], whose non-`sigma` defaults these mirror). sharp's
/// legacy positional `sharpen(sigma, flat, jagged)` form is a TS-side (`E5`)
/// concern, not part of this wire schema — this is always the object form.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SharpenOp {
    #[serde(default)]
    pub sigma: Option<f64>,
    #[serde(default = "one")]
    pub m1: f64,
    #[serde(default = "two")]
    pub m2: f64,
    #[serde(default = "two")]
    pub x1: f64,
    #[serde(default = "ten")]
    pub y2: f64,
    #[serde(default = "twenty")]
    pub y3: f64,
}

/// Wire shape for `Op::Median`. `size` defaults to 3, matching sharp's own
/// argument-less `median()`; any integer in `[1, 1000]` is accepted at the
/// `RasterImage::median` layer, even sizes included (#3504 task E5
/// controller ruling (c) — see that function's doc comment).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MedianOp {
    #[serde(default = "three")]
    pub size: u32,
}

/// Wire shape for `Op::Threshold`. sharp's `threshold({grayscale})`
/// American-spelling alias is a TS-side (`E5`) concern resolved before the
/// wire, not accepted here — `grayscale` on this schema is a stray key,
/// rejected by `deny_unknown_fields` like any other typo.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThresholdOp {
    #[serde(default = "one_two_eight")]
    pub value: u8,
    #[serde(default = "yes")]
    pub greyscale: bool,
}

/// Wire shape for `Op::Convolve`. `scale` is `Option<f64>` rather than a
/// plain `f64` with a `0.0` default specifically to keep sharp's "absent"
/// and "explicit 0" apart: `RasterImage::convolve`'s own contract treats a
/// literal `0.0` as "use the kernel's sum" (a raw-core-level sentinel, not
/// sharp's), while sharp's real API clips an explicit `scale: 0` (or any
/// non-positive value) to a minimum of `1.0` and only falls back to the
/// kernel sum when the caller omits `scale` entirely. [`apply_filter_op`]
/// is what reconciles the two — see its own doc comment.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConvolveOp {
    pub width: u32,
    pub height: u32,
    pub kernel: Vec<f64>,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub offset: f64,
}

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
/// to a minimum of `1.0`. `ConvolveOp.scale` is `Option<f64>` precisely so
/// this function can tell the two apart: `None` (absent) is passed straight
/// through as raw-core's `0.0` sentinel, `Some(v)` (explicit, sharp's rules)
/// is clamped to `v.max(1.0)` first. See [`ConvolveOp`]'s doc comment for
/// the wire-level rationale.
pub(crate) fn apply_filter_op(image: &RasterImage, op: &Op) -> Option<Result<RasterImage>> {
    match op {
        Op::Blur(BlurOp { sigma }) => Some(image.blur(*sigma)),
        Op::Sharpen(SharpenOp {
            sigma,
            m1,
            m2,
            x1,
            y2,
            y3,
        }) => Some(image.sharpen(&SharpenOptions {
            sigma: *sigma,
            m1: *m1,
            m2: *m2,
            x1: *x1,
            y2: *y2,
            y3: *y3,
        })),
        Op::Median(MedianOp { size }) => Some(image.median(*size)),
        Op::Threshold(ThresholdOp { value, greyscale }) => {
            Some(Ok(image.threshold(*value, *greyscale)))
        }
        Op::Convolve(ConvolveOp {
            width,
            height,
            kernel,
            scale,
            offset,
        }) => {
            let resolved_scale = scale.map_or(0.0, |s| s.max(1.0));
            Some(image.convolve(*width, *height, kernel, resolved_scale, *offset))
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "raster_recipe_filter_tests.rs"]
mod tests;

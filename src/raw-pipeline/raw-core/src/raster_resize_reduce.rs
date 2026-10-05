//! libvips' `vips_resize` downscale path for the convolution kernels
//! (#4177), ported so a sharp-compatible downscale lands on sharp's bytes.
//!
//! `fast_image_resize` evaluates the requested kernel once, in float, at the
//! final output position. libvips does something different for every
//! non-`nearest` downscale (`resize.c` → `reducev.cpp`/`reduceh.cpp` →
//! `shrinkv.c`/`shrinkh.c`, v8.17.3 — what sharp 0.34.5 ships), and that
//! staging is what this module reproduces:
//!
//! 1. Vertical first, then horizontal — each a separate 8-bit pass, so the
//!    vertical result is rounded and clamped to a byte before the
//!    horizontal pass ever sees it.
//! 2. Per axis, `vips_reduce`'s `gap` (sharp leaves it at 2.0) splits the
//!    factor: an integer part `floor(in / out / gap)` runs first as a box
//!    average (`vips_shrink`, `ceil` mode, fixed-point `>> 24` divide), and
//!    only the residual runs the kernel.
//! 3. The kernel runs on 64 pre-sampled sub-pixel phases, each mask
//!    normalised in double and then TRUNCATED to 12-bit fixed point
//!    (`(short) (c * 4096)`); the sum is rounded with `+2048 >> 12` and
//!    clamped to a byte. Edges extend by copy.
//!
//! The arithmetic below is integer and order-independent once the masks
//! are built, so libvips' C, Highway and ORC uchar paths all agree with it.
//! Upscales are not routed here: libvips sends them through
//! `vips_affine` instead (#4178).

use fast_image_resize as fr;
use rayon::prelude::*;

use super::FilterAlg;
use crate::error::{Error, Result};
use crate::raster::RasterImage;

/// `vips_resize`'s default `gap`, which sharp never overrides.
const GAP: f64 = 2.0;
/// `VIPS_TRANSFORM_SCALE`: sub-pixel phases the masks are pre-sampled at.
const PHASES: usize = 64;
/// `VIPS_INTERPOLATE_SHIFT` / `VIPS_INTERPOLATE_SCALE`: mask fixed point.
const MASK_SHIFT: u32 = 12;
const MASK_SCALE: f64 = (1 << MASK_SHIFT) as f64;

/// Whether `vips_resize` takes the reduce path for this request: no axis
/// enlarging. (`nearest` stages through `vips_subsample` + residual reduce,
/// and any enlarging axis detours through `vips_affine`.)
pub(crate) fn applies(_filter: FilterAlg, (hshrink, vshrink): (f64, f64)) -> bool {
    hshrink >= 1.0 && vshrink >= 1.0
}

/// The factor `vips_resize` hands `vips_reduce{h,v}` for one axis, or
/// `None` when that axis is left alone. sharp passes the scale `1 /
/// shrink` and libvips inverts it again, clamping so no axis drops below
/// one pixel — both steps are kept so the factor is the same double.
fn reduce_factor(shrink: f64, dim: u32) -> Option<f64> {
    let scale = (1.0 / shrink).max(1.0 / dim as f64);
    (scale < 1.0).then(|| 1.0 / scale)
}

/// Downscale `src` to `dst_w` x `dst_h` the way `vips_resize` does, with
/// `(hshrink, vshrink)` the per-axis factors from `resolve_shrink`.
/// `mul_div_alpha` wraps an RGBA run in the same premultiply/divide pair
/// the `fast_image_resize` path uses.
pub(crate) fn reduce(
    src: &RasterImage,
    (hshrink, vshrink): (f64, f64),
    (dst_w, dst_h): (u32, u32),
    filter: FilterAlg,
    mul_div_alpha: bool,
) -> Result<RasterImage> {
    let expected_len = (src.width as usize)
        .checked_mul(src.height as usize)
        .and_then(|px| px.checked_mul(src.channels as usize));
    if expected_len != Some(src.data.len()) {
        return Err(Error::Decode {
            path: "<memory>".into(),
            reason: format!(
                "raster buffer length {} does not match dimensions {}x{}x{}",
                src.data.len(),
                src.width,
                src.height,
                src.channels,
            ),
        });
    }
    let alpha = match src.channels {
        3 => false,
        4 => mul_div_alpha && filter != FilterAlg::Nearest,
        other => {
            return Err(Error::Decode {
                path: "<memory>".into(),
                reason: format!("unsupported channel count: {other}"),
            })
        }
    };
    let mut img = Bytes {
        width: src.width as usize,
        height: src.height as usize,
        channels: src.channels as usize,
        data: src.data.clone(),
    };
    if alpha {
        img = alpha_pass(img, |m, view| m.multiply_alpha_inplace(view))?;
    }
    if let Some(factor) = reduce_factor(vshrink, src.height) {
        for stage in axis_stages(img.height, dst_h as usize, factor, filter) {
            img = vertical(&img, &stage);
        }
    }
    if let Some(factor) = reduce_factor(hshrink, src.width) {
        for stage in axis_stages(img.width, dst_w as usize, factor, filter) {
            img = horizontal(&img, &stage);
        }
    }
    if alpha {
        img = alpha_pass(img, |m, view| m.divide_alpha_inplace(view))?;
    }
    Ok(RasterImage {
        width: img.width as u32,
        height: img.height as u32,
        channels: src.channels,
        data: img.data,
        orientation: src.orientation,
    })
}

/// An interleaved 8-bit image between passes.
struct Bytes {
    width: usize,
    height: usize,
    channels: usize,
    data: Vec<u8>,
}

/// Run one of `fast_image_resize`'s in-place RGBA alpha operations.
fn alpha_pass(
    img: Bytes,
    op: impl FnOnce(
        &fr::MulDiv,
        &mut fr::images::Image<'static>,
    ) -> std::result::Result<(), fr::ImageError>,
) -> Result<Bytes> {
    let fail = |e: &dyn std::fmt::Display| Error::Decode {
        path: "<memory>".into(),
        reason: format!("alpha (de)multiplication failed: {e}"),
    };
    let (w, h) = (img.width as u32, img.height as u32);
    let mut view = fr::images::Image::from_vec_u8(w, h, img.data, fr::PixelType::U8x4)
        .map_err(|e| fail(&e))?;
    op(&fr::MulDiv::default(), &mut view).map_err(|e| fail(&e))?;
    Ok(Bytes {
        data: view.into_vec(),
        ..img
    })
}

/// One 1-D resampling pass: for every output position, `n` source indices
/// (already edge-clamped) and how to combine the samples found there.
struct Stage {
    out_len: usize,
    n: usize,
    /// `out_len * n` source indices along the axis.
    taps: Vec<usize>,
    combine: Combine,
}

enum Combine {
    /// `vips_shrink`'s uchar box average: `((sum + amend) * mult) >> 24`
    /// in wrapping 32-bit arithmetic, `mult = 2^32 / (256 * shrink)`.
    Box { amend: u32, mult: u32 },
    /// `vips_reduce`'s 12-bit masks, `out_len * n` of them, one per tap.
    Mask(Vec<i16>),
    /// `vips_subsample` and `vips_reduce` nearest: direct point sampling.
    Point,
}

impl Stage {
    /// Fold one output sample from its `n` source samples, `at(i)` being
    /// the byte under tap `i` of output `o`.
    #[inline]
    fn sample(&self, o: usize, at: impl Fn(usize) -> u8) -> u8 {
        let base = o * self.n;
        match &self.combine {
            Combine::Point => at(self.taps[base]),
            Combine::Box { amend, mult } => {
                let sum: u32 = (0..self.n)
                    .map(|i| u32::from(at(self.taps[base + i])))
                    .sum();
                ((sum + amend).wrapping_mul(*mult) >> 24).min(255) as u8
            }
            Combine::Mask(masks) => {
                let sum: i32 = (0..self.n)
                    .map(|i| i32::from(masks[base + i]) * i32::from(at(self.taps[base + i])))
                    .sum();
                ((sum + (1 << (MASK_SHIFT - 1))) >> MASK_SHIFT).clamp(0, 255) as u8
            }
        }
    }
}

fn vertical(img: &Bytes, stage: &Stage) -> Bytes {
    let row = img.width * img.channels;
    let mut data = vec![0u8; stage.out_len * row];
    data.par_chunks_mut(row.max(1))
        .enumerate()
        .for_each(|(o, out)| {
            for (e, px) in out.iter_mut().enumerate() {
                *px = stage.sample(o, |y| img.data[y * row + e]);
            }
        });
    Bytes {
        height: stage.out_len,
        data,
        ..*img
    }
}

fn horizontal(img: &Bytes, stage: &Stage) -> Bytes {
    let (c, in_row, out_row) = (
        img.channels,
        img.width * img.channels,
        stage.out_len * img.channels,
    );
    let mut data = vec![0u8; img.height * out_row];
    data.par_chunks_mut(out_row.max(1))
        .zip(img.data.par_chunks(in_row.max(1)))
        .for_each(|(out, src)| {
            for (i, px) in out.iter_mut().enumerate() {
                let (o, b) = (i / c, i % c);
                *px = stage.sample(o, |x| src[x * c + b]);
            }
        });
    Bytes {
        width: stage.out_len,
        data,
        ..*img
    }
}

/// `vips_reduce{h,v}_build` for one axis: the optional integer box shrink or
/// subsample, then the residual kernel pass. `out_len` is the length the caller
/// sized this axis to (libvips' `VIPS_ROUND_UINT(in / factor)`).
fn axis_stages(in_len: usize, out_len: usize, factor: f64, filter: FilterAlg) -> Vec<Stage> {
    let mut stages = Vec::with_capacity(2);
    let mut len = in_len;
    let mut residual = factor;
    // How many input pixels the output grid invents (negative: discards).
    let mut extra = out_len as f64 * factor - in_len as f64;
    let int_shrink = ((in_len as f64 / out_len as f64 / GAP).floor() as usize).max(1);
    if int_shrink > 1 {
        stages.push(if filter == FilterAlg::Nearest {
            subsample_stage(len, int_shrink)
        } else {
            box_stage(len, int_shrink)
        });
        len = if filter == FilterAlg::Nearest {
            len / int_shrink
        } else {
            len.div_ceil(int_shrink)
        };
        residual /= int_shrink as f64;
        extra = if filter == FilterAlg::Nearest {
            out_len as f64 * residual - len as f64
        } else {
            extra / int_shrink as f64
        };
    }
    if residual != 1.0 || len != out_len {
        stages.push(mask_stage(len, out_len, residual, extra, filter));
    }
    stages
}

/// `vips_shrink{h,v}` with `ceil`: `ceil(len / shrink)` outputs, the last
/// block padded by repeating the edge sample.
fn box_stage(len: usize, shrink: usize) -> Stage {
    let out_len = len.div_ceil(shrink);
    let taps = (0..out_len * shrink).map(|i| i.min(len - 1)).collect();
    Stage {
        out_len,
        n: shrink,
        taps,
        combine: Combine::Box {
            amend: (shrink / 2) as u32,
            mult: ((1u64 << 32) / (256 * shrink as u64)) as u32,
        },
    }
}

/// `vips_subsample` for one axis: `len / shrink` outputs, point-sampled
/// every `shrink` pixels.
fn subsample_stage(len: usize, shrink: usize) -> Stage {
    let out_len = len / shrink;
    let taps = (0..out_len).map(|i| i * shrink).collect();
    Stage {
        out_len,
        n: 1,
        taps,
        combine: Combine::Point,
    }
}

/// The residual `vips_reduce` pass from `len` to `out_len` samples.
fn mask_stage(len: usize, out_len: usize, shrink: f64, extra: f64, filter: FilterAlg) -> Stage {
    let n = points(filter, shrink);
    // Centre the output grid when rounding invented or dropped pixels.
    let offset = (1.0 + extra) / 2.0 - 1.0;
    // `vips_embed` pads this many copies before the first sample.
    let pad = n.div_ceil(2) as i64 - 1;
    let table: Vec<Vec<i16>> = if filter == FilterAlg::Nearest {
        Vec::new()
    } else {
        (0..=PHASES)
            .map(|phase| fixed_mask(filter, n, shrink, phase as f64 / PHASES as f64))
            .collect()
    };
    let mut taps = Vec::with_capacity(out_len * n);
    let mut masks = Vec::with_capacity(if filter == FilterAlg::Nearest {
        0
    } else {
        out_len * n
    });
    // Accumulated, not recomputed per output, exactly as libvips walks it.
    let mut x = 0.5 * shrink - 0.5 - offset;
    for _ in 0..out_len {
        let ix = x as i64;
        for i in 0..n as i64 {
            taps.push((ix + i - pad).clamp(0, len as i64 - 1) as usize);
        }
        if filter != FilterAlg::Nearest {
            let sub = (x * (PHASES * 2) as f64) as i64 & (PHASES as i64 * 2 - 1);
            let phase = ((sub + 1) >> 1) as usize;
            masks.extend_from_slice(&table[phase]);
        }
        x += shrink;
    }
    Stage {
        out_len,
        n,
        taps,
        combine: if filter == FilterAlg::Nearest {
            Combine::Point
        } else {
            Combine::Mask(masks)
        },
    }
}

/// `vips_reduce_get_points`. `rint` rounds half to even.
fn points(filter: FilterAlg, shrink: f64) -> usize {
    let support = match filter {
        FilterAlg::Bilinear => 1.0,
        FilterAlg::CatmullRom | FilterAlg::Mitchell | FilterAlg::Lanczos2 => 2.0,
        FilterAlg::Lanczos3 => 3.0,
        FilterAlg::Nearest => return 1,
    };
    2 * (support * shrink).round_ties_even() as usize + 1
}

/// `calculate_coefficients` followed by the `(short) (c * 4096)` cast:
/// the mask is normalised in double, then each tap truncates toward zero,
/// which is where libvips' fixed-point loss comes from.
fn fixed_mask(filter: FilterAlg, n: usize, shrink: f64, x: f64) -> Vec<i16> {
    let half = x + n as f64 / 2.0 - 1.0;
    let c: Vec<f64> = (0..n)
        .map(|i| kernel(filter, (i as f64 - half) / shrink))
        .collect();
    let sum: f64 = c.iter().sum();
    c.iter().map(|&v| (v / sum * MASK_SCALE) as i16).collect()
}

/// libvips' `filter<K>` kernels (`templates.h`), operation order kept.
fn kernel(filter: FilterAlg, x: f64) -> f64 {
    match filter {
        FilterAlg::Nearest => 1.0,
        FilterAlg::Bilinear => {
            let x = x.abs();
            if x < 1.0 {
                1.0 - x
            } else {
                0.0
            }
        }
        FilterAlg::CatmullRom => cubic(x, 0.0, 0.5),
        FilterAlg::Mitchell => cubic(x, 1.0 / 3.0, 1.0 / 3.0),
        FilterAlg::Lanczos2 if (-2.0..=2.0).contains(&x) => sinc(x) * sinc(x / 2.0),
        FilterAlg::Lanczos3 if (-3.0..=3.0).contains(&x) => sinc(x) * sinc(x / 3.0),
        FilterAlg::Lanczos2 | FilterAlg::Lanczos3 => 0.0,
    }
}

fn sinc(x: f64) -> f64 {
    if x == 0.0 {
        return 1.0;
    }
    let x = x * std::f64::consts::PI;
    x.sin() / x
}

/// Mitchell–Netravali family: B = 0, C = 1/2 is Catmull-Rom.
fn cubic(x: f64, b: f64, c: f64) -> f64 {
    let ax = x.abs();
    let ax2 = ax * ax;
    let ax3 = ax2 * ax;
    if ax <= 1.0 {
        return ((12.0 - 9.0 * b - 6.0 * c) * ax3
            + (-18.0 + 12.0 * b + 6.0 * c) * ax2
            + (6.0 - 2.0 * b))
            / 6.0;
    }
    if ax <= 2.0 {
        return ((-b - 6.0 * c) * ax3
            + (6.0 * b + 30.0 * c) * ax2
            + (-12.0 * b - 48.0 * c) * ax
            + (8.0 * b + 24.0 * c))
            / 6.0;
    }
    0.0
}

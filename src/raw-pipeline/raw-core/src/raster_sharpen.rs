//! Unsharp-mask `sharpen` (#3504), matching libvips' `vips_sharpen`: blur
//! the L* channel in CIELAB, take the blur-minus-original difference, run it
//! through a piecewise "flat vs jagged" transfer function, and add it back.
//! a*, b* (hue) and any alpha channel are never touched, so sharpening can't
//! shift colour, only local contrast.
//!
//! `sigma: None` is a different code path entirely — sharp's real
//! no-argument `sharpen()` skips Lab and the transfer altogether and runs a
//! fixed 3x3 kernel directly on the colour bands (see [`fast_sharpen`]).
//!
//! Split out of `raster_filter.rs` — which already holds `blur` and is
//! reused here via `convolve_separable`/`gaussian_kernel` — purely to stay
//! under this crate's 400-line soft file-size budget. There's no functional
//! reason the two couldn't share a file.
//!
//! **The Lab conversion below is local to this file, not `raster_lab.rs`.**
//! A separate lane of this same plan (#3504, plan D1) is adding a
//! `raster_lab` module with its own `srgb_to_lab`/`lab_to_srgb`, but that
//! lane hasn't landed on `feat/3504-filters` yet. `sharpen` only needs a
//! standard, invertible sRGB<->CIELAB round trip, so this file carries its
//! own minimal D65 conversion (`srgb_to_lab`/`lab_to_srgb`) rather than
//! block on the other lane or copy its file wholesale. When the lanes
//! merge, these two implementations should be reconciled into one shared
//! module — noted as a concern in this task's report, not filed as a new
//! ticket, since it's a same-plan integration detail.

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use crate::raster_filter::{convolve_separable, gaussian_kernel};

/// D65 reference white (CIE 1931 2° observer) — the white point both
/// conversions below are normalised against.
const WHITE_X: f64 = 0.95047;
const WHITE_Y: f64 = 1.0;
const WHITE_Z: f64 = 1.08883;

/// sRGB gamma decode: an 8-bit channel to linear light in `[0, 1]`.
fn srgb_channel_to_linear(c: u8) -> f64 {
    let c = c as f64 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Inverse of [`srgb_channel_to_linear`]: linear light in `[0, 1]` to an
/// 8-bit sRGB channel, rounded and clamped.
fn linear_to_srgb_channel(c: f64) -> u8 {
    let encoded = if c <= 0.0031308 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (encoded * 255.0).round().clamp(0.0, 255.0) as u8
}

/// CIELAB's forward companding function, shared by the `L*`/`a*`/`b*`
/// derivation.
fn lab_f(t: f64) -> f64 {
    const DELTA: f64 = 6.0 / 29.0;
    if t > DELTA * DELTA * DELTA {
        t.cbrt()
    } else {
        t / (3.0 * DELTA * DELTA) + 4.0 / 29.0
    }
}

/// Inverse of [`lab_f`].
fn lab_f_inv(t: f64) -> f64 {
    const DELTA: f64 = 6.0 / 29.0;
    if t > DELTA {
        t * t * t
    } else {
        3.0 * DELTA * DELTA * (t - 4.0 / 29.0)
    }
}

/// 8-bit sRGB to CIELAB (D65), as `[L*, a*, b*]`. `L*` is `[0, 100]`; `a*`
/// and `b*` are unbounded in general but small for in-gamut sRGB colours.
pub(crate) fn srgb_to_lab(rgb: [u8; 3]) -> [f32; 3] {
    let [r, g, b] = rgb.map(srgb_channel_to_linear);

    // Linear sRGB (D65) to XYZ — IEC 61966-2-1.
    let x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;

    let fx = lab_f(x / WHITE_X);
    let fy = lab_f(y / WHITE_Y);
    let fz = lab_f(z / WHITE_Z);

    [
        (116.0 * fy - 16.0) as f32,
        (500.0 * (fx - fy)) as f32,
        (200.0 * (fy - fz)) as f32,
    ]
}

/// Inverse of [`srgb_to_lab`]: CIELAB `[L*, a*, b*]` to 8-bit sRGB.
pub(crate) fn lab_to_srgb(lab: [f32; 3]) -> [u8; 3] {
    let [l, a, b] = lab.map(f64::from);
    let fy = (l + 16.0) / 116.0;
    let fx = fy + a / 500.0;
    let fz = fy - b / 200.0;

    let x = WHITE_X * lab_f_inv(fx);
    let y = WHITE_Y * lab_f_inv(fy);
    let z = WHITE_Z * lab_f_inv(fz);

    // XYZ to linear sRGB (D65) — inverse of the matrix in `srgb_to_lab`.
    let r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    let g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
    let bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

    [r, g, bl].map(linear_to_srgb_channel)
}

/// Clamp-to-edge index into `0..len` (mirrors `raster_filter::clamp_index`;
/// duplicated locally rather than shared, since it's a one-line helper and
/// [`fast_sharpen`]'s 2-D tap pattern isn't the separable horizontal/
/// vertical shape that module's version is written for).
#[inline]
fn clamp_index(i: i64, len: usize) -> usize {
    i.clamp(0, len as i64 - 1) as usize
}

/// sharp's real fast, no-argument `sharpen()`: a fixed 3x3 sharpening
/// kernel applied directly to the colour bands with clamp-to-edge
/// addressing — no Lab conversion, no `m1`/`m2`/`x1`/`y2`/`y3` transfer.
/// Mirrors sharp's own `operations.cc` (~lines 237-244 in sharp 0.34.x):
/// kernel `[-1,-1,-1; -1,32,-1; -1,-1,-1] / 24`. The divisor equals the
/// kernel's weight sum, so a flat region is returned unchanged. Alpha is
/// left alone, same as the Lab path.
///
/// The accumulate-then-divide is plain integer arithmetic, truncating
/// toward zero, NOT `f64` + `round()` — this is libvips' own uchar
/// convolution path (`vips_convi`), which truncates rather than rounds to
/// nearest. Confirmed against sharp 0.34.5's real output on the 60/200 step
/// edge two independent ways (`.sharpen()` with no arguments, and
/// `.convolve({kernel, scale: 24, offset: 0})` with this exact kernel):
/// both give 42/217 at the pixels adjacent to the edge — sums of 1020/24 =
/// 42.5 and 5220/24 = 217.5, truncated down, not `f64::round`'s 43/218
/// (round-half-away-from-zero). A non-half sum agrees under either
/// convention (e.g. 6032/24 = 251.33… is 251 either way), so this only
/// matters at an exact `.5`.
fn fast_sharpen(src: &RasterImage) -> RasterImage {
    const KERNEL: [[i32; 3]; 3] = [[-1, -1, -1], [-1, 32, -1], [-1, -1, -1]];
    const DIVISOR: i32 = 24;

    let c = src.channels as usize;
    let bands = c.min(3);
    let (w, h) = (src.width as usize, src.height as usize);
    let mut data = vec![0u8; src.data.len()];

    for y in 0..h {
        for x in 0..w {
            let base = (y * w + x) * c;
            for band in 0..bands {
                let acc: i32 = KERNEL
                    .iter()
                    .enumerate()
                    .flat_map(|(ky, row)| row.iter().enumerate().map(move |(kx, w)| (ky, kx, w)))
                    .map(|(ky, kx, weight)| {
                        let sy = clamp_index(y as i64 + ky as i64 - 1, h);
                        let sx = clamp_index(x as i64 + kx as i64 - 1, w);
                        src.data[(sy * w + sx) * c + band] as i32 * weight
                    })
                    .sum();
                // `/` on `i32` truncates toward zero, matching libvips: a
                // positive half-integer (42.5) truncates down to 42. A
                // negative sum (a very dark centre against very bright
                // neighbours) also truncates toward zero — e.g. -12/24 is
                // 0, not -1 — and `clamp` pins it at 0 regardless.
                data[base + band] = (acc / DIVISOR).clamp(0, 255) as u8;
            }
            for band in bands..c {
                data[base + band] = src.data[base + band];
            }
        }
    }

    RasterImage {
        data,
        ..src.clone()
    }
}

/// sharp's own sigma domain for the mask-based `sharpen()` (`lib/operation.js`),
/// distinct from `blur`'s `[0.3, 1000]`.
const SHARPEN_MIN_SIGMA: f64 = 0.000001;
const SHARPEN_MAX_SIGMA: f64 = 10.0;

/// sharp's `sharpen` options. Non-`sigma` defaults are sharp's documented
/// defaults for its mask-based (Lab) path.
///
/// `x1`, `y2` and `y3` are all on the **0..100 `L*` scale** — the same scale
/// `srgb_to_lab` produces — not a packed-byte scale. Confirmed against sharp
/// 0.34.5's real output on a 60/200 step edge: default options move the
/// pixel adjacent to the edge from 60 to 18 and from 200 to 228 (matching a
/// `y3`/`y2`-saturated CIELAB delta of ~-19.85/+9.99), and `{sigma: 2, m2:
/// 20, y2: 2, y3: 2}` moves the same pixels to 56/206 (ΔL* ≈ ±2) — both only
/// reproduce on this scale, not a 0..255 one.
#[derive(Clone, Copy, Debug)]
pub struct SharpenOptions {
    /// `None` is sharp's fast, argument-less `sharpen()` — [`fast_sharpen`],
    /// no Lab, no transfer. `Some(sigma)` is the mask-based Gaussian unsharp
    /// mask, in `[SHARPEN_MIN_SIGMA, SHARPEN_MAX_SIGMA]` (sharp's own
    /// domain for this operation, not `blur`'s).
    pub sigma: Option<f64>,
    /// Slope applied to differences below `x1` — "flat" areas.
    pub m1: f64,
    /// Slope applied to differences above `x1` — "jagged" areas.
    pub m2: f64,
    /// Threshold between flat and jagged. See the struct doc comment for
    /// the scale.
    pub x1: f64,
    /// Maximum brightening. See the struct doc comment for the scale.
    pub y2: f64,
    /// Maximum darkening. See the struct doc comment for the scale.
    pub y3: f64,
}

impl Default for SharpenOptions {
    fn default() -> Self {
        Self {
            sigma: None,
            m1: 1.0,
            m2: 2.0,
            x1: 2.0,
            y2: 10.0,
            y3: 20.0,
        }
    }
}

/// The piecewise transfer libvips applies to the unsharp difference: slope
/// `m1` up to `x1`, then slope `m2`, clipped to `+y2`/`-y3`. All four of
/// `x1`/`m1`/`m2`/`y2`/`y3` and `difference` share the 0..100 `L*` scale —
/// see [`SharpenOptions`]'s doc comment.
fn unsharp_transfer(difference: f64, o: &SharpenOptions) -> f64 {
    let magnitude = difference.abs();
    let boosted = if magnitude < o.x1 {
        magnitude * o.m1
    } else {
        o.x1 * o.m1 + (magnitude - o.x1) * o.m2
    };
    let signed = boosted.copysign(difference);
    signed.clamp(-o.y3, o.y2)
}

impl RasterImage {
    /// `sigma: None`: sharp's fast, argument-less kernel ([`fast_sharpen`]).
    /// `sigma: Some(s)`: unsharp mask on the L* channel in CIELAB, matching
    /// `vips_sharpen` — blur L*, take the difference, run it through the
    /// piecewise transfer, add it back. a*, b* and alpha are untouched, so
    /// sharpening never shifts hue.
    ///
    /// An out-of-range or `NaN` `sigma` is a caller-parameter error, not a
    /// decode failure, so — matching `blur`'s ruling in this same plan — it
    /// is reported as [`Error::Pipeline`] rather than [`Error::Decode`].
    pub fn sharpen(&self, options: &SharpenOptions) -> Result<Self> {
        let Some(sigma) = options.sigma else {
            return Ok(fast_sharpen(self));
        };
        if !(SHARPEN_MIN_SIGMA..=SHARPEN_MAX_SIGMA).contains(&sigma) {
            return Err(Error::Pipeline(format!(
                "sharpen sigma {sigma} is outside [{SHARPEN_MIN_SIGMA}, {SHARPEN_MAX_SIGMA}]"
            )));
        }
        let kernel = gaussian_kernel(sigma);

        let c = self.channels as usize;
        let labs: Vec<[f32; 3]> = self
            .data
            .chunks_exact(c)
            .map(|px| srgb_to_lab([px[0], px[1], px[2]]))
            .collect();
        // Carry L* through the shared separable helper by packing it into
        // an 8-bit single-band raster scaled to 0..255; ~0.4 L* units of
        // quantisation is well inside the tolerances the transfer works at.
        // This packing is purely a mechanical requirement of reusing
        // `convolve_separable` (which is written against `u8` data) — the
        // difference and the transfer below immediately unpack back to the
        // 0..100 `L*` scale `SharpenOptions` documents.
        let l_plane = RasterImage {
            width: self.width,
            height: self.height,
            channels: 1,
            data: labs
                .iter()
                .map(|lab| (lab[0] * 2.55).round().clamp(0.0, 255.0) as u8)
                .collect(),
            orientation: self.orientation,
        };
        // `colour_only` only decides whether band 3 (alpha) is skipped;
        // `l_plane` has exactly one band, so there's no alpha to skip and
        // `true`/`false` are equivalent here — passed as `false` simply for
        // consistency with `blur`'s "filter every band" default.
        let blurred = convolve_separable(&l_plane, &kernel, false);
        let data = labs
            .iter()
            .enumerate()
            .zip(self.data.chunks_exact(c))
            .flat_map(|((i, lab), px)| {
                let difference = (l_plane.data[i] as f64 - blurred.data[i] as f64) / 2.55;
                let l = (lab[0] as f64 + unsharp_transfer(difference, options)).clamp(0.0, 100.0)
                    as f32;
                let rgb = lab_to_srgb([l, lab[1], lab[2]]);
                rgb.into_iter().chain(px.get(3).copied())
            })
            .collect();
        Ok(Self {
            data,
            ..self.clone()
        })
    }
}

#[cfg(test)]
#[path = "raster_sharpen_tests.rs"]
mod tests;

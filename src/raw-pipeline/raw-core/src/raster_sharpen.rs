//! Unsharp-mask `sharpen` (#3504), matching libvips' `vips_sharpen`: blur
//! the L* channel in CIELAB, take the blur-minus-original difference, run it
//! through a piecewise "flat vs jagged" transfer function, and add it back.
//! a*, b* (hue) and any alpha channel are never touched, so sharpening can't
//! shift colour, only local contrast.
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
use crate::raster_filter::{convolve_separable, gaussian_kernel, MAX_SIGMA, MIN_SIGMA};

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

/// sharp's `sharpen` options. Defaults are sharp's documented defaults.
#[derive(Clone, Copy, Debug)]
pub struct SharpenOptions {
    /// `None` is the fast mild 3x3 sharpen sharp performs with no
    /// arguments; `Some(sigma)` is a Gaussian unsharp mask, sharing
    /// `blur`'s `[0.3, 1000]` sigma domain.
    pub sigma: Option<f64>,
    /// Slope applied to differences below `x1` — "flat" areas.
    pub m1: f64,
    /// Slope applied to differences above `x1` — "jagged" areas.
    pub m2: f64,
    /// Threshold between flat and jagged, on the 0..255 packed-L scale
    /// `sharpen` works in internally (see `sharpen`'s doc comment) — the
    /// same scale sharp/libvips calibrate their own defaults against, not
    /// the 0..100 L* scale.
    pub x1: f64,
    /// Maximum brightening, on the same 0..255 packed-L scale as `x1`.
    pub y2: f64,
    /// Maximum darkening, on the same 0..255 packed-L scale as `x1`.
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
/// `m1` up to `x1`, then slope `m2`, clipped to `+y2`/`-y3`.
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
    /// Unsharp mask on the L* channel in CIELAB, matching `vips_sharpen`:
    /// blur L*, take the difference, run it through the piecewise transfer,
    /// add it back. a*, b* and alpha are untouched, so sharpening never
    /// shifts hue.
    ///
    /// The difference and the transfer run on the 0..255 packed-L scale
    /// (`SharpenOptions::x1`'s doc comment), matching where sharp/libvips'
    /// default `m1`/`m2`/`x1`/`y2`/`y3` are calibrated — only the final
    /// result is rescaled back to 0..100 L* before the return to sRGB.
    ///
    /// An out-of-range or `NaN` `sigma` is a caller-parameter error, not a
    /// decode failure, so — matching `blur`'s ruling in this same plan — it
    /// is reported as [`Error::Pipeline`] rather than [`Error::Decode`].
    pub fn sharpen(&self, options: &SharpenOptions) -> Result<Self> {
        let c = self.channels as usize;
        let labs: Vec<[f32; 3]> = self
            .data
            .chunks_exact(c)
            .map(|px| srgb_to_lab([px[0], px[1], px[2]]))
            .collect();
        // Carry L* through the shared separable helper by packing it into
        // an 8-bit single-band raster scaled to 0..255; ~0.4 L* units of
        // quantisation is well inside the tolerances the transfer works at.
        //
        // sharp/libvips' documented `m1`/`m2`/`x1`/`y2`/`y3` are calibrated
        // against this same 0..255 packed-L scale (the historical LabQ
        // encoding `vips_sharpen` processes), not the 0..100 L* scale — so
        // `difference`, the transfer, and the add-back below all stay in
        // 0..255 units, and only the final result is rescaled back to 0..100
        // for the Lab->sRGB step.
        let l_bytes: Vec<u8> = labs
            .iter()
            .map(|lab| (lab[0] * 2.55).round().clamp(0.0, 255.0) as u8)
            .collect();
        let l_plane = RasterImage {
            width: self.width,
            height: self.height,
            channels: 1,
            data: l_bytes.clone(),
            orientation: self.orientation,
        };
        let kernel = match options.sigma {
            None => vec![1.0 / 3.0; 3],
            Some(s) if (MIN_SIGMA..=MAX_SIGMA).contains(&s) => gaussian_kernel(s),
            Some(s) => {
                return Err(Error::Pipeline(format!(
                    "sharpen sigma {s} is outside [{MIN_SIGMA}, {MAX_SIGMA}]"
                )))
            }
        };
        // `convolve_separable` is written against `src.channels`, so a
        // `channels: 1` raster works without a special case — `colour_only`
        // is irrelevant on a single-band image, so `false` is passed for
        // consistency with `blur`'s "filter every band" default.
        let blurred = convolve_separable(&l_plane, &kernel, false);
        let data = labs
            .iter()
            .enumerate()
            .zip(self.data.chunks_exact(c))
            .flat_map(|((i, lab), px)| {
                let difference = l_bytes[i] as f64 - blurred.data[i] as f64;
                let l_byte_new =
                    (l_bytes[i] as f64 + unsharp_transfer(difference, options)).clamp(0.0, 255.0);
                let l = (l_byte_new / 2.55) as f32;
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

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
//! Split out of `raster_filter.rs` — which already holds `blur` — purely to
//! stay under this crate's 400-line soft file-size budget. The two share
//! `raster_filter_conv.rs`'s libvips convolution primitives but nothing
//! else; in particular `sharpen`'s Gaussian mask is NOT `blur`'s.
//!
//! **`sharpen` has its own mask rule and its own working domain.**
//! `vips_sharpen` calls `vips_gaussmat(sigma, 0.1, separable, INTEGER)` —
//! amplitude cutoff **0.1**, where `vips_gaussblur` (and so sharp's `blur`)
//! uses 0.2 — which makes the mask reach `floor(sigma * 2.146)` rather than
//! `floor(sigma * 1.794)`. It then blurs `L*` as **signed 16-bit** data on
//! libvips' LABS scale (`L* * 327.67`, i.e. 0..32767), not as bytes, and
//! applies the flat/jagged transfer through a `rint`ed lookup on that same
//! scale. Both details are measured, not inferred: on 32x32 noise against
//! sharp 0.34.5, keeping the 0.1 cutoff and the 16-bit domain gives a max
//! diff of 1 across `{sigma 1, 1.5, 2, 5}` with assorted `m1`/`m2`, where
//! blurring a byte-packed `L*` plane instead costs 4 to 24 levels and
//! using `blur`'s 0.2 cutoff costs 28 to 42.
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
use crate::raster_filter_chain::{run_filter_chain, FilterOp, Plane};
use crate::raster_filter_conv::{conv_f64, convsep_i32, gaussmat_int};

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

/// sharp's real fast, argument-less `sharpen()`: a fixed 3x3 sharpening
/// kernel applied with clamp-to-edge addressing — no Lab conversion, no
/// `m1`/`m2`/`x1`/`y2`/`y3` transfer. Mirrors sharp's own `operations.cc`:
/// kernel `[-1,-1,-1; -1,32,-1; -1,-1,-1]` with scale 24, handed to a bare
/// `image.conv(mask)`. The divisor equals the kernel's weight sum, so a flat
/// region is returned unchanged.
///
/// Two things about it are easy to get wrong and both are measured against
/// sharp 0.34.5. First, `vips_conv` defaults to FLOAT precision and writes a
/// float image, so the division truncates only at the filter run's final
/// cast: on the 60/200 step edge the pixels either side of the edge come out
/// 42 and 217 (sums 1020/24 = 42.5 and 5220/24 = 217.5), not the rounded
/// 43/218 — confirmed two independent ways, `.sharpen()` with no arguments
/// and `.convolve({kernel, scale: 24})` with this exact kernel. Second, it
/// convolves **every** band including alpha, and nothing is clamped inside
/// the operation: on an 8x4 fixture that is opaque `(200,10,10)` on the left
/// and fully transparent `(0,250,0)` on the right, sharp's output at the
/// first transparent column is `(200,10,10,0)`, which is only reachable if
/// the alpha accumulator reaches the unpremultiply as −31.875 and the red
/// accumulator as −25.0. Skipping alpha, or clamping either at 0 first,
/// gives a completely different pixel.
fn fast_sharpen(plane: &Plane) -> Plane {
    const KERNEL: [f64; 9] = [-1.0, -1.0, -1.0, -1.0, 32.0, -1.0, -1.0, -1.0, -1.0];
    plane.with_data(conv_f64(
        &plane.data,
        plane.width,
        plane.height,
        plane.channels,
        3,
        3,
        &KERNEL,
        24.0,
        0.0,
    ))
}

/// sharp's own sigma domain for the mask-based `sharpen()` (`lib/operation.js`),
/// distinct from `blur`'s `[0.3, 1000]`.
const SHARPEN_MIN_SIGMA: f64 = 0.000001;
const SHARPEN_MAX_SIGMA: f64 = 10.0;

/// sharp's shared range for `m1`/`m2`/`x1`/`y2`/`y3` (`lib/operation.js`'s
/// `is.inRange(value, 0, 1000000)` checks on `sharpen`'s options object,
/// #3504 task E5 controller ruling (b)) — every one of the five transfer
/// parameters shares this same domain.
const SHARPEN_PARAM_MIN: f64 = 0.0;
const SHARPEN_PARAM_MAX: f64 = 1_000_000.0;

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

/// `vips_sharpen`'s own amplitude cutoff for its Gaussian mask — 0.1, not
/// `blur`'s 0.2. See the module doc for the measured consequence.
const SHARPEN_MIN_AMPL: f64 = 0.1;

/// libvips' LABS scale factor: `L*` 0..100 maps to a signed 16-bit 0..32767,
/// so one `L*` unit is 327.67 counts. `vips_sharpen` blurs, differences and
/// transfers `L*` entirely on this scale.
const LABS_PER_L: f64 = 327.67;

/// One `sharpen` over a filter run's working buffer.
pub(crate) fn sharpen_plane(plane: &Plane, options: &SharpenOptions) -> Result<Plane> {
    // #3504 task E5 controller ruling (b): validate every one of the five
    // transfer parameters, named individually, before doing anything else —
    // matching sharp's own unconditional `is.inRange` checks on
    // `options.m1`/`m2`/`x1`/`y2`/`y3`, which run whether or not `sigma` is
    // also given.
    for (name, value) in [
        ("m1", options.m1),
        ("m2", options.m2),
        ("x1", options.x1),
        ("y2", options.y2),
        ("y3", options.y3),
    ] {
        if !(SHARPEN_PARAM_MIN..=SHARPEN_PARAM_MAX).contains(&value) {
            return Err(Error::Pipeline(format!(
                "sharpen {name} {value} is outside [{SHARPEN_PARAM_MIN}, {SHARPEN_PARAM_MAX}]"
            )));
        }
    }
    let Some(sigma) = options.sigma else {
        return Ok(fast_sharpen(plane));
    };
    if !(SHARPEN_MIN_SIGMA..=SHARPEN_MAX_SIGMA).contains(&sigma) {
        return Err(Error::Pipeline(format!(
            "sharpen sigma {sigma} is outside [{SHARPEN_MIN_SIGMA}, {SHARPEN_MAX_SIGMA}]"
        )));
    }

    let c = plane.channels;
    let bytes = plane.to_u8();
    let labs: Vec<[f32; 3]> = bytes
        .chunks_exact(c)
        .map(|px| srgb_to_lab([px[0], px[1], px[2]]))
        .collect();
    // `vips_colourspace(LABS)` then `vips_cast_short`: L* on the 0..32767
    // scale, as signed 16-bit.
    let l_short: Vec<i32> = labs
        .iter()
        .map(|lab| ((lab[0] as f64 * LABS_PER_L).round() as i32).clamp(0, 32767))
        .collect();
    let (mask, scale) = gaussmat_int(sigma, SHARPEN_MIN_AMPL);
    let blurred = convsep_i32(&l_short, plane.width, plane.height, &mask, scale);
    let data = labs
        .iter()
        .enumerate()
        .zip(plane.data.chunks_exact(c))
        .flat_map(|((i, lab), px)| {
            let difference = (l_short[i] - blurred[i]) as f64 / LABS_PER_L;
            // libvips builds a 65536-entry lookup of `rint(transfer * 327.67)`
            // and adds it to the unblurred L*, clipping to the short range.
            let lut = (unsharp_transfer(difference, options) * LABS_PER_L).round() as i32;
            let sharpened = (l_short[i] + lut).clamp(0, 32767);
            let rgb = srgb_from_labs(sharpened, lab[1], lab[2]);
            rgb.into_iter()
                .map(f64::from)
                .chain(px.get(3).copied())
                .collect::<Vec<f64>>()
        })
        .collect();
    Ok(plane.with_data(data))
}

/// A sharpened LABS `L*` plus the original `a*`/`b*`, back to 8-bit sRGB.
fn srgb_from_labs(l_short: i32, a: f32, b: f32) -> [u8; 3] {
    lab_to_srgb([(l_short as f64 / LABS_PER_L) as f32, a, b])
}

impl RasterImage {
    /// `sigma: None`: sharp's fast, argument-less kernel ([`fast_sharpen`]).
    /// `sigma: Some(s)`: unsharp mask on the L* channel in CIELAB, matching
    /// `vips_sharpen` — blur L*, take the difference, run it through the
    /// piecewise transfer, add it back. a*, b* and alpha are untouched, so
    /// sharpening never shifts hue. On a 4-channel image the filter runs
    /// inside the premultiply sandwich, like every other sharp filter — see
    /// [`crate::raster_filter_chain`].
    ///
    /// An out-of-range or `NaN` `sigma` is a caller-parameter error, not a
    /// decode failure, so — matching `blur`'s ruling in this same plan — it
    /// is reported as [`Error::Pipeline`] rather than [`Error::Decode`]. The
    /// same holds for `m1`/`m2`/`x1`/`y2`/`y3`: each is validated to
    /// `[SHARPEN_PARAM_MIN, SHARPEN_PARAM_MAX]` and named individually in
    /// its error, matching sharp's own per-field `is.inRange` checks
    /// (#3504 task E5 controller ruling (b)).
    pub fn sharpen(&self, options: &SharpenOptions) -> Result<Self> {
        run_filter_chain(self, &[FilterOp::Sharpen(*options)])
    }
}

#[cfg(test)]
#[path = "raster_sharpen_tests.rs"]
mod tests;

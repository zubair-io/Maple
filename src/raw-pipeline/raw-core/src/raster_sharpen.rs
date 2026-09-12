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
//! **The colour chain is libvips', not a textbook one.** `sharpen({sigma})`
//! converts through `raster_labs.rs`, which reproduces
//! `vips_colourspace(LABS)` stage for stage — see that file for why an
//! approximate conversion is not good enough here (its round trip has to be
//! an exact identity, or a premultiplied image amplifies the error by
//! `255/alpha`). A separate lane of this same plan (#3504, plan D1) is
//! adding a `raster_lab` module of its own; when the lanes merge, the two
//! should be reconciled — noted as a concern in this task's report rather
//! than filed as a new ticket, since it is a same-plan integration detail.

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use crate::raster_filter_chain::{run_filter_chain, FilterOp, Plane};
use crate::raster_filter_conv::{conv_f64, convsep_i32, gaussmat_int};
use crate::raster_labs::{labs_to_srgb, srgb_to_labs, LABS_PER_L};

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
    // `vips_colourspace(LABS)`: L*, a*, b* as signed 16-bit counts. a* and
    // b* go through that packing too, and come back through it untouched —
    // `vips_sharpen` only ever rewrites band 0.
    let labs: Vec<[i32; 3]> = plane
        .to_u8()
        .chunks_exact(c)
        .map(|px| srgb_to_labs([px[0], px[1], px[2]]))
        .collect();
    let l_plane: Vec<i32> = labs.iter().map(|lab| lab[0]).collect();
    let (mask, scale) = gaussmat_int(sigma, SHARPEN_MIN_AMPL);
    let blurred = convsep_i32(&l_plane, plane.width, plane.height, &mask, scale);
    let data = labs
        .iter()
        .enumerate()
        .zip(plane.data.chunks_exact(c))
        .flat_map(|((i, lab), px)| {
            // libvips builds a 65536-entry lookup of `rint(transfer * 327.67)`
            // and adds it to the unblurred L*, clipping to the short range.
            //
            // The `+ 1` is not a fudge: `vips_sharpen_generate` indexes that
            // lookup with `diff + 32768` while `vips_sharpen_build` fills
            // entry `i` from `(i - 32767) / 327.67`, so the difference the
            // transfer actually sees is one LabS count higher than the
            // difference that was measured. It is a real off-by-one in
            // libvips, and reproducing it is worth a byte: without it every
            // sample that disagreed with sharp 0.34.5 disagreed the same way,
            // one code low (13 samples of 3072 on 32x32 noise at sigma 1.5,
            // and the same bias amplified to 85 by the unpremultiply at
            // alpha 3).
            let difference = (lab[0] - blurred[i] + 1) as f64 / LABS_PER_L;
            // `rint`, so ties go to even — with m1 or m2 at a half-integer
            // the product lands exactly on .5 often enough to matter.
            let lut = (unsharp_transfer(difference, options) * LABS_PER_L).round_ties_even() as i32;
            let sharpened = (lab[0] + lut).clamp(0, 32767);
            labs_to_srgb([sharpened, lab[1], lab[2]])
                .into_iter()
                .map(f64::from)
                .chain(px.get(3).copied())
                .collect::<Vec<f64>>()
        })
        .collect();
    Ok(plane.with_data(data))
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

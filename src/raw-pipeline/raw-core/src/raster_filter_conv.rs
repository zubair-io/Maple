//! The libvips convolution primitives sharp's filters are built from
//! (#3504 PR-E final fix wave), derived from libvips 8.17.3 source and
//! measured against sharp 0.34.5 / libvips 8.17.3.
//!
//! There are exactly two of them, and which one an operation uses is the
//! single biggest thing to get right:
//!
//! 1. **`vips_conv` at FLOAT precision** — [`conv_f64`]. This is
//!    `vips_conv`'s *default* (`libvips/convolution/conv.c`:
//!    `VIPS_PRECISION_FLOAT`), and its output image is float, not `uchar`:
//!    nothing is clamped or quantised until whoever owns the chain casts
//!    back to bytes. `convolve()`, `blur()` with no sigma, and the
//!    argument-less `sharpen()` all reach libvips as a plain
//!    `image.conv(mask)` (sharp's `operations.cc`), so all three are float
//!    convolutions with a single truncating cast at the very end.
//!
//! 2. **`vips_convsep` at INTEGER precision** — [`convsep_u8`] /
//!    [`convsep_i32`]. `blur(sigma)` reaches libvips as `vips_gaussblur`,
//!    which passes sharp's `precision` option (default `'integer'`) down to
//!    `vips_convsep`, and `vips_sharpen` hard-codes the same. At INTEGER
//!    precision `vips_convsep` runs **two separate `vips_conv` calls** (the
//!    mask, then the mask rotated 90°), each of which keeps the input's band
//!    format — so there IS a byte quantisation between the horizontal and
//!    the vertical pass, and emulating the pair as one f64 two-pass is
//!    measurably wrong.
//!
//! Inside the integer path libvips has two implementations of its own and
//! picks between them per mask:
//!
//! - the **vector path** (`convi_hwy.cpp`, used for `uchar` input whenever
//!   [`intize`] succeeds): the mask is converted to 8.8 fixed point sharing
//!   one exponent, `sum = Σ pixel·mant`, then
//!   `(sum + 1 << (exp-1)) >> exp` — an arithmetic shift, so
//!   round-half-toward-`+∞` — then a saturating demote to `u8`.
//! - the **C path** (`vips_convi_gen` + `vips__image_intize`, used for
//!   non-`uchar` input or when `intize` bails): the mask is `rint`ed, the
//!   scale nudged to preserve the mask's input/output ratio, and
//!   `sum = clip(((sum + scale/2) / scale) + offset)` with C integer
//!   division.
//!
//! [`intize`]'s accuracy gate is what selects between them, and it is
//! floating-point sensitive in a way that matters: libvips assigns
//! `Σ 128·mask[i]/scale` to an `int`, which truncates, so a mask whose taps
//! sum to `0.9999999999999999` in `f64` scores 127 rather than 128 and can
//! fail a gate it would otherwise pass. Measured consequence on sharp
//! 0.34.5: `blur(0.6)` (taps `[5, 20, 5]`, scale 30) takes the C path while
//! every other sigma from 0.3 to 6.2 in 0.1 steps takes the vector path —
//! reproducing that single exception is worth up to 7 levels on 32x32
//! noise, so the gate is emulated here rather than assumed away.

/// Clamp-to-edge index into `0..len`, which is what `vips_embed`'s
/// `VIPS_EXTEND_COPY` (how every `vips_conv` pads its input) does.
#[inline]
pub(crate) fn clamp_index(i: i64, len: usize) -> usize {
    i.clamp(0, len as i64 - 1) as usize
}

/// `vips_gaussmat(sigma, min_ampl, separable: true, precision: INTEGER)`:
/// the separable 1-D mask `blur(sigma)` and `sharpen(sigma)` convolve with,
/// as `(taps, scale)`.
///
/// The size rule is [`gaussmat_radius`]'s; the taps themselves are
/// `rint(20·exp(-x²/2σ²))` (libvips scales an integer Gaussian to a peak of
/// 20, not to 1) and `scale` is their sum, forced to 1 if they sum to zero.
pub(crate) fn gaussmat_int(sigma: f64, min_ampl: f64) -> (Vec<i64>, i64) {
    let sig2 = 2.0 * sigma * sigma;
    let radius = gaussmat_radius(sigma, min_ampl);
    let taps: Vec<i64> = (-radius..=radius)
        .map(|x| (20.0 * (-((x * x) as f64) / sig2).exp()).round_ties_even() as i64)
        .collect();
    let sum: i64 = taps.iter().sum();
    (taps, if sum == 0 { 1 } else { sum })
}

/// Mask radius for `min_ampl`: libvips walks outward from the centre and
/// stops at the first tap whose amplitude `exp(-x²/2σ²)` has fallen *below*
/// `min_ampl`, then keeps everything strictly inside it —
/// `width = 2·max(x-1, 0) + 1`. That is `floor(σ·sqrt(-2·ln(min_ampl)))`,
/// and it is legitimately **0**: at `min_ampl` 0.2 (sharp's `blur` default)
/// every sigma up to 0.557 produces a 1x1 mask, which makes sharp's
/// `blur(0.3)`…`blur(0.557)` an exact identity — measured byte-identical on
/// 32x32 noise.
///
/// The walk is also bounded by libvips' own `max_x = (int) 8·σ`, which is
/// why the loop below stops there rather than solving the inequality: at
/// very small sigmas the two rules disagree and the bound wins.
pub(crate) fn gaussmat_radius(sigma: f64, min_ampl: f64) -> i64 {
    let sig2 = 2.0 * sigma * sigma;
    let max_x = (8.0 * sigma) as i64;
    let first_below = (0..max_x)
        .find(|x| (-((x * x) as f64) / sig2).exp() < min_ampl)
        .unwrap_or(max_x);
    (first_below - 1).max(0)
}

/// libvips' `vips_convi_intize`: the mask as 8.8 fixed-point mantissas
/// sharing one exponent, or `None` when libvips would reject the
/// approximation and fall back to its C path. See the module doc.
fn intize(mask: &[i64], scale: i64) -> Option<(Vec<i64>, u32)> {
    if (mask.len() as f64).log2().ceil() > 10.0 {
        return None;
    }
    let scaled: Vec<f64> = mask.iter().map(|&m| m as f64 / scale as f64).collect();
    let mx = scaled.iter().copied().fold(f64::MIN, f64::max);
    let shift = (mx.log2() + 1.0).ceil();
    let exp = 7.0 - shift;
    if exp <= 0.0 || exp > 31.0 {
        return None;
    }
    let mant: Vec<i64> = scaled
        .iter()
        .map(|s| (128.0 * s * (-shift).exp2()).round_ties_even() as i64)
        .collect();
    if mant.iter().any(|&m| m < -128 || m > 127) {
        return None;
    }
    // The accuracy gate, over the non-zero mantissas libvips squeezes the
    // mask down to. `true_value` truncates, which is the whole point — see
    // the module doc.
    let (true_sum, int_sum) = mant
        .iter()
        .zip(&scaled)
        .filter(|(&m, _)| m != 0)
        .fold((0.0f64, 0i64), |(t, i), (&m, &s)| {
            (t + 128.0 * s, i + 128 * m)
        });
    let exp = exp as u32;
    let true_value = (true_sum as i64).clamp(0, 255);
    let int_value = ((int_sum + (1 << (exp - 1))) >> exp).clamp(0, 255);
    if (true_value - int_value).abs() > 2 {
        return None;
    }
    Some((mant, exp))
}

/// libvips' `vips__image_intize`: `rint` the mask, then nudge the scale so
/// the integer mask has the same input-to-output ratio the float one had.
fn c_path_scale(mask: &[i64], scale: i64) -> i64 {
    let double_result = mask.iter().sum::<i64>() as f64 / scale as f64;
    let out_scale = if scale == 0 { 1 } else { scale };
    let int_result = mask.iter().sum::<i64>() / out_scale;
    let nudged = (out_scale as f64 + (int_result as f64 - double_result)).round_ties_even() as i64;
    if nudged == 0 {
        1
    } else {
        nudged
    }
}

/// One 1-D integer convolution pass: `weights` applied horizontally or
/// vertically with clamp-to-edge addressing, each accumulated sum handed to
/// `finish` (the path-specific divide-and-round) and then to `clamp`.
fn conv_pass_int(
    src: &[i64],
    w: usize,
    h: usize,
    c: usize,
    weights: &[i64],
    horizontal: bool,
    finish: impl Fn(i64) -> i64,
    lo: i64,
    hi: i64,
) -> Vec<i64> {
    let radius = (weights.len() / 2) as i64;
    let finish = &finish;
    (0..h)
        .flat_map(|y| {
            (0..w).flat_map(move |x| {
                (0..c).map(move |band| {
                    let acc: i64 = weights
                        .iter()
                        .enumerate()
                        .map(|(k, &weight)| {
                            let offset = k as i64 - radius;
                            let (sx, sy) = if horizontal {
                                (clamp_index(x as i64 + offset, w), y)
                            } else {
                                (x, clamp_index(y as i64 + offset, h))
                            };
                            src[(sy * w + sx) * c + band] * weight
                        })
                        .sum();
                    finish(acc).clamp(lo, hi)
                })
            })
        })
        .collect()
}

/// `vips_convsep` at INTEGER precision over `uchar` data: two `vips_conv`
/// passes, each quantised back to `u8`, taking libvips' vector path when the
/// mask intizes and its C path otherwise (see the module doc).
pub(crate) fn convsep_u8(
    data: &[u8],
    w: usize,
    h: usize,
    c: usize,
    mask: &[i64],
    scale: i64,
) -> Vec<u8> {
    let vector = intize(mask, scale);
    let (weights, out_scale) = match &vector {
        Some((mant, _)) => (mant.as_slice(), 0),
        None => (mask, c_path_scale(mask, scale)),
    };
    let exp = vector.as_ref().map(|(_, e)| *e);
    let finish = move |acc: i64| match exp {
        Some(e) => (acc + (1 << (e - 1))) >> e,
        None => (acc + out_scale / 2) / out_scale,
    };
    let plane: Vec<i64> = data.iter().map(|&v| v as i64).collect();
    let horizontal = conv_pass_int(&plane, w, h, c, weights, true, finish, 0, 255);
    conv_pass_int(&horizontal, w, h, c, weights, false, finish, 0, 255)
        .into_iter()
        .map(|v| v as u8)
        .collect()
}

/// `vips_convsep` at INTEGER precision over single-band `short` data — the
/// domain `vips_sharpen` blurs `L*` in. libvips' vector path is `uchar`-only,
/// so a `short` image always takes the C path, and the per-pass clamp is the
/// signed 16-bit range rather than `0..255`.
pub(crate) fn convsep_i32(data: &[i32], w: usize, h: usize, mask: &[i64], scale: i64) -> Vec<i32> {
    let out_scale = c_path_scale(mask, scale);
    let rounding = out_scale / 2;
    let finish = move |acc: i64| (acc + rounding) / out_scale;
    let plane: Vec<i64> = data.iter().map(|&v| v as i64).collect();
    let horizontal = conv_pass_int(&plane, w, h, 1, mask, true, finish, -32768, 32767);
    conv_pass_int(&horizontal, w, h, 1, mask, false, finish, -32768, 32767)
        .into_iter()
        .map(|v| v as i32)
        .collect()
}

/// `vips_conv` at FLOAT precision: a full 2-D `kw` x `kh` convolution of
/// every band in `f64`, clamp-to-edge at the boundary, `sum / divisor +
/// offset`, and **no clamping of the result** — libvips' float conv writes a
/// float image, so an over- or undershoot survives into whatever comes next.
/// That is load-bearing on an image with alpha: sharp's own output for a
/// fully transparent pixel next to an opaque one is only reproducible if the
/// negative alpha accumulator survives into the unpremultiply's division.
pub(crate) fn conv_f64(
    data: &[f64],
    w: usize,
    h: usize,
    c: usize,
    kw: usize,
    kh: usize,
    kernel: &[f64],
    divisor: f64,
    offset: f64,
) -> Vec<f64> {
    let (rx, ry) = ((kw / 2) as i64, (kh / 2) as i64);
    (0..h)
        .flat_map(|y| {
            (0..w).flat_map(move |x| {
                (0..c).map(move |band| {
                    let acc: f64 = (0..kh)
                        .flat_map(|ky| (0..kw).map(move |kx| (ky, kx)))
                        .map(|(ky, kx)| {
                            let sy = clamp_index(y as i64 + ky as i64 - ry, h);
                            let sx = clamp_index(x as i64 + kx as i64 - rx, w);
                            data[(sy * w + sx) * c + band] * kernel[ky * kw + kx]
                        })
                        .sum();
                    acc / divisor + offset
                })
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "raster_filter_conv_tests.rs"]
mod tests;

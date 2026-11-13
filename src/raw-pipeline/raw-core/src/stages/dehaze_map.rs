//! The dehaze haze map (#3287): atmospheric light, the guided-filter
//! transmission coefficients and the sky mask, measured once over the whole
//! frame at ONE fixed proxy resolution.
//!
//! Every window radius below is in proxy pixels, so the map — and therefore
//! the look — no longer depends on the resolution being rendered: a fit
//! preview, a 100 MP export and a 100% tile measure the same map to within
//! the resampling of their input, and sample it bilinearly into their own
//! pixel grid. The transmission is reconstructed
//! per rendered pixel from the upsampled guided-filter coefficients and the
//! rendered pixel's own luma (He & Sun's fast guided filter), so edges stay
//! as sharp as the render while the statistics stay frame-global.

use rayon::prelude::*;

use super::{smoothstep, AIRLIGHT_FLOOR, TRANSMISSION_OMEGA};
use crate::image::Image;

/// Long edge, in pixels, of the grid the haze map is measured on. 2048 is
/// the resolution a fit preview on a Retina laptop or iPad already rendered
/// dehaze at, so the window sizes below keep the look photographers tuned
/// against while editing; it bounds the map at ~34 MB retained and a few
/// hundred MB transient whatever the sensor size.
pub const HAZE_PROXY_LONG_EDGE: u32 = 2048;

/// 15×15 dark-channel / transmission window, in proxy pixels.
pub(super) const DARK_RADIUS: usize = 7;
/// Guided-filter radius for the transmission refine, in proxy pixels.
pub(super) const GUIDED_RADIUS: usize = 60;
pub(super) const GUIDED_EPS: f32 = 1e-3;
/// "Sky / no-dark-pixel" mask (#272): the dark-channel prior fails where
/// every channel is high (sky, snow, white walls), so recovery fades out
/// between these dark-channel levels, feathered by a light blur.
pub(super) const SKY_MASK_LOW: f32 = 0.40;
pub(super) const SKY_MASK_HIGH: f32 = 0.60;
pub(super) const SKY_MASK_BLUR_RADIUS: usize = 8;

/// Rec.2020 luma, the guided filter's guide. One expression shared by the
/// measurement and the per-pixel reconstruction so the two agree exactly.
#[inline]
pub(super) fn luma(p: [f32; 3]) -> f32 {
    0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2]
}

/// The guided filter's guide: luma measured from the airlight's luma. The
/// filter is shift-invariant, but its window sums are not: hazy pixels sit
/// near `A`, where an uncentred guide makes `mean(I²) − mean(I)²` cancel
/// catastrophically in f32 and `cov / eps` amplify it. Centring keeps the
/// CPU and WGSL coefficients within the parity budget.
#[inline]
pub(super) fn guide(p: [f32; 3], airlight: [f32; 3]) -> f32 {
    luma(p) - luma(airlight)
}

/// A frame's haze map at proxy resolution. It depends on the pixels dehaze
/// receives and never on the dehaze amount, so a dehaze-slider move reuses it.
#[derive(Clone, Debug, PartialEq)]
pub struct HazeMap {
    pub width: u32,
    pub height: u32,
    /// Atmospheric light `A`, the raw (unfloored) recovery value.
    pub airlight: [f32; 3],
    /// Box-filtered guided-filter coefficients `(mean_a, mean_b)`; the
    /// refined transmission at a rendered pixel is `a · (luma − luma(A)) + b`
    /// (see [`guide`]).
    pub coefficients: Vec<[f32; 2]>,
    /// Feathered sky mask in `[0, 1]`; `1` passes the input through.
    pub sky: Vec<f32>,
}

/// Proxy grid for a frame of `width × height`: long edge
/// [`HAZE_PROXY_LONG_EDGE`], aspect kept, every edge at least one pixel.
pub fn proxy_dims(width: u32, height: u32) -> (u32, u32) {
    let long = u64::from(width.max(height).max(1));
    let scale = |edge: u32| {
        let scaled = (u64::from(edge) * u64::from(HAZE_PROXY_LONG_EDGE) + long / 2) / long;
        scaled.max(1) as u32
    };
    (scale(width), scale(height))
}

impl HazeMap {
    /// Measure the map of a whole frame.
    /// An empty frame measures the identity map (transmission 1, all sky).
    pub fn measure(img: &Image) -> HazeMap {
        if img.width == 0 || img.height == 0 {
            return HazeMap {
                width: 1,
                height: 1,
                airlight: [1.0; 3],
                coefficients: vec![[0.0, 1.0]],
                sky: vec![1.0],
            };
        }
        let (width, height) = proxy_dims(img.width, img.height);
        let proxy = resample(img, width as usize, height as usize);
        measure_proxy(&proxy, width as usize, height as usize)
    }

    /// Resident bytes, for host memory accounting.
    pub fn byte_len(&self) -> usize {
        self.coefficients.len() * std::mem::size_of::<[f32; 2]>()
            + self.sky.len() * std::mem::size_of::<f32>()
    }
}

/// Block-average `img` onto a `pw × ph` grid. Proxy pixel `i` covers source
/// columns `[i·W/pw, max(i·W/pw + 1, (i+1)·W/pw))` (integer division), so a
/// larger source is area-averaged and a smaller one is sampled nearest. The
/// WGSL `dehaze_downsample` kernel uses the same bounds and sum order.
pub(super) fn resample(img: &Image, pw: usize, ph: usize) -> Vec<[f32; 3]> {
    let (w, h) = (img.width as usize, img.height as usize);
    let mut out = vec![[0.0f32; 3]; pw * ph];
    out.par_chunks_mut(pw).enumerate().for_each(|(j, row)| {
        let (y0, y1) = span(j, h, ph);
        for (i, cell) in row.iter_mut().enumerate() {
            let (x0, x1) = span(i, w, pw);
            let mut sum = [0.0f32; 3];
            for y in y0..y1 {
                for p in &img.pixels[y * w + x0..y * w + x1] {
                    sum[0] += p[0];
                    sum[1] += p[1];
                    sum[2] += p[2];
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f32;
            *cell = [sum[0] / n, sum[1] / n, sum[2] / n];
        }
    });
    out
}

#[inline]
fn span(i: usize, src: usize, dst: usize) -> (usize, usize) {
    let start = i * src / dst;
    (start, ((i + 1) * src / dst).max(start + 1))
}

pub(super) fn measure_proxy(proxy: &[[f32; 3]], w: usize, h: usize) -> HazeMap {
    let channel_min: Vec<f32> = proxy.iter().map(|p| p[0].min(p[1]).min(p[2])).collect();
    let dc = window_min(&channel_min, w, h);
    drop(channel_min);
    let airlight = atmospheric_light(proxy, &dc);
    let floored = airlight.map(|a| a.max(AIRLIGHT_FLOOR));
    let scaled_min: Vec<f32> = proxy
        .iter()
        .map(|p| {
            (p[0] / floored[0])
                .min(p[1] / floored[1])
                .min(p[2] / floored[2])
        })
        .collect();
    let t_raw: Vec<f32> = window_min(&scaled_min, w, h)
        .into_iter()
        .map(|m| 1.0 - TRANSMISSION_OMEGA * m)
        .collect();
    drop(scaled_min);
    let guide: Vec<f32> = proxy.iter().map(|&p| guide(p, airlight)).collect();
    let coefficients = guided_coefficients(&guide, &t_raw, w, h, GUIDED_RADIUS, GUIDED_EPS);
    HazeMap {
        width: w as u32,
        height: h as u32,
        airlight,
        coefficients,
        sky: sky_mask(&dc, w, h),
    }
}

/// `(2r+1)²` window minimum with clamp-to-edge borders, done separably: a
/// clamped square window is the product of two clamped 1-D windows, so the
/// row pass then column pass equals the direct 2-D minimum exactly.
pub(super) fn window_min(values: &[f32], w: usize, h: usize) -> Vec<f32> {
    let r = DARK_RADIUS;
    let mut rows = vec![0.0f32; values.len()];
    rows.par_chunks_mut(w).enumerate().for_each(|(y, out)| {
        let src = &values[y * w..(y + 1) * w];
        for (x, v) in out.iter_mut().enumerate() {
            let lo = x.saturating_sub(r);
            let hi = (x + r).min(w - 1);
            *v = src[lo..=hi].iter().copied().fold(f32::INFINITY, f32::min);
        }
    });
    let mut out = vec![0.0f32; values.len()];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let lo = y.saturating_sub(r);
        let hi = (y + r).min(h - 1);
        for (x, v) in row.iter_mut().enumerate() {
            *v = (lo..=hi)
                .map(|yy| rows[yy * w + x])
                .fold(f32::INFINITY, f32::min);
        }
    });
    out
}

/// Atmospheric light: the mean colour at the brightest 0.1% of dark-channel
/// positions. Ranked by dark channel, ties by position, so the selected set
/// and the summation order are unique; summed in f64 so the ~4000-texel
/// average does not drift.
pub(super) fn atmospheric_light(proxy: &[[f32; 3]], dc: &[f32]) -> [f32; 3] {
    let n = dc.len();
    let top_n = (n / 1000).max(1);
    let order = |a: &usize, b: &usize| dc[*b].total_cmp(&dc[*a]).then(a.cmp(b));
    let mut idx: Vec<usize> = (0..n).collect();
    if top_n < n {
        idx.select_nth_unstable_by(top_n - 1, order);
    }
    let top = &mut idx[..top_n];
    top.sort_unstable_by(order);
    let sum = top.iter().fold([0.0f64; 3], |s, &i| {
        let p = proxy[i].map(f64::from);
        [s[0] + p[0], s[1] + p[1], s[2] + p[2]]
    });
    let k = top_n as f64;
    sum.map(|s| (s / k) as f32)
}

/// Truncated-window box mean (the window shrinks at the borders) of radius
/// `r`, via a running sum per row then per column.
pub(super) fn box_blur(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; buf.len()];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, out)| {
        running_mean(&buf[y * w..(y + 1) * w], r, |x, v| out[x] = v);
    });
    let mut cols = vec![0.0f32; buf.len()];
    cols.par_chunks_mut(h).enumerate().for_each(|(x, out)| {
        let column: Vec<f32> = (0..h).map(|y| tmp[y * w + x]).collect();
        running_mean(&column, r, |y, v| out[y] = v);
    });
    drop(tmp);
    let mut out = vec![0.0f32; buf.len()];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, v) in row.iter_mut().enumerate() {
            *v = cols[x * h + y];
        }
    });
    out
}

/// The running sum is kept in f64: over a 2048-texel proxy row an f32 sum
/// drifts by more than the GPU's direct window sum differs from the truth.
fn running_mean(line: &[f32], r: usize, mut emit: impl FnMut(usize, f32)) {
    let n = line.len();
    let right0 = r.min(n - 1);
    let mut acc: f64 = line[..=right0].iter().map(|&v| f64::from(v)).sum();
    let mut count = right0 + 1;
    emit(0, (acc / count as f64) as f32);
    for x in 1..n {
        if x + r < n {
            acc += f64::from(line[x + r]);
            count += 1;
        }
        if x > r {
            acc -= f64::from(line[x - r - 1]);
            count -= 1;
        }
        emit(x, (acc / count as f64) as f32);
    }
}

/// Guided filter (He, Sun, Tang 2010) of `p` by `guide`, stopped before the
/// final reconstruction: returns the box-filtered `(mean_a, mean_b)` so the
/// refined value can be rebuilt at any resolution as `mean_a · guide + mean_b`.
pub(super) fn guided_coefficients(
    guide: &[f32],
    p: &[f32],
    w: usize,
    h: usize,
    r: usize,
    eps: f32,
) -> Vec<[f32; 2]> {
    let products = |f: fn(f32, f32) -> f32| -> Vec<f32> {
        guide.iter().zip(p).map(|(&i, &q)| f(i, q)).collect()
    };
    let mean_i = box_blur(guide, w, h, r);
    let mean_p = box_blur(p, w, h, r);
    let mean_ip = box_blur(&products(|i, q| i * q), w, h, r);
    let mean_ii = box_blur(&products(|i, _| i * i), w, h, r);
    // Variance is clamped at zero: at scene-linear magnitudes ≫ 1 the
    // `mean_ii − mean_i²` cancellation can round negative, flipping the
    // denominator's sign and blowing `a` up (#1177).
    let (a, b): (Vec<f32>, Vec<f32>) = (0..guide.len())
        .map(|k| {
            let cov = mean_ip[k] - mean_i[k] * mean_p[k];
            let var = (mean_ii[k] - mean_i[k] * mean_i[k]).max(0.0);
            let a = cov / (var + eps);
            (a, mean_p[k] - a * mean_i[k])
        })
        .unzip();
    box_blur(&a, w, h, r)
        .into_iter()
        .zip(box_blur(&b, w, h, r))
        .map(|(a, b)| [a, b])
        .collect()
}

pub(super) fn sky_mask(dc: &[f32], w: usize, h: usize) -> Vec<f32> {
    let raw: Vec<f32> = dc
        .iter()
        .map(|&v| smoothstep(SKY_MASK_LOW, SKY_MASK_HIGH, v))
        .collect();
    box_blur(&raw, w, h, SKY_MASK_BLUR_RADIUS)
}

/// Bilinear sample position along one axis: rendered pixel `index` of a
/// `frame`-pixel axis lands at proxy coordinate `(index + ½)·proxy/frame − ½`,
/// clamped to the grid. Returns the two taps and the far tap's weight. The
/// WGSL recovery kernel evaluates the same f32 expression.
#[inline]
pub(super) fn axis_taps(index: i64, frame: u32, proxy: u32) -> (usize, usize, f32) {
    if frame == 0 || proxy == 0 {
        return (0, 0, 0.0);
    }
    let u = ((index as f32 + 0.5) * (proxy as f32 / frame as f32) - 0.5).max(0.0);
    let last = proxy as usize - 1;
    let i0 = (u.floor() as usize).min(last);
    let i1 = (i0 + 1).min(last);
    (i0, i1, (u - i0 as f32).clamp(0.0, 1.0))
}

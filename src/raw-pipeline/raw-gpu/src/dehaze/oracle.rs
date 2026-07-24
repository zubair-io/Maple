//! Dehaze's CPU oracle (epic #925 P2 wave 3b / #990) — split from `dehaze.rs` for
//! the file-size budget (#1033 pushed the parent past 600 LOC). A faithful,
//! line-for-line port of `raw_core::stages::dehaze`'s PRIVATE primitives
//! (`box_blur` / `guided_filter` / `dark_channel` / `atmospheric_light` /
//! `transmission` / `sky_mask` / `recover_with_mask`) plus the public entry points
//! [`apply_dehaze`] (the full-stage oracle) and [`compute_airlight`] (the global
//! atmospheric-light reduction, byte-exact vs raw-core). The dehaze parity test
//! (`dehaze/tests.rs`) pins this oracle — and transitively the GPU kernels — to
//! the REAL `raw_core::stages::dehaze::apply`, so a transcription slip here cannot
//! mask a kernel bug. Shares the stage constants from the parent via `use super::*`.

use super::*;

// ── CPU oracle: verbatim port of raw-core's dehaze primitives ─────────────────
//
// `box_blur` / `guided_filter` / `dark_channel` / `atmospheric_light` /
// `transmission` / `sky_mask` / `recover_with_mask` are private in raw-core, so
// these copies keep the oracle self-contained. The parity test pins the GPU (and
// transitively this oracle) to the REAL `raw_core::stages::dehaze::apply`, so a
// transcription slip here cannot mask a kernel bug. Kept line-faithful.

/// Dark channel: 15×15 window min of `min(r,g,b)`, CLAMP-TO-EDGE borders.
/// Faithful to `raw_core::stages::dehaze::dark_channel`.
fn dark_channel(pixels: &[[f32; 3]], w: usize, h: usize) -> Vec<f32> {
    let wi = w as i32;
    let hi = h as i32;
    let r = DARK_RADIUS as i32;
    let mut out = vec![0.0f32; w * h];
    for y in 0..hi {
        for x in 0..wi {
            let mut m = f32::INFINITY;
            for dy in -r..=r {
                for dx in -r..=r {
                    let ux = (x + dx).clamp(0, wi - 1) as usize;
                    let uy = (y + dy).clamp(0, hi - 1) as usize;
                    let p = pixels[uy * w + ux];
                    let local_min = p[0].min(p[1]).min(p[2]);
                    if local_min < m {
                        m = local_min;
                    }
                }
            }
            out[(y * wi + x) as usize] = m;
        }
    }
    out
}

/// Atmospheric light A: mean of the original image at the brightest 0.1% of
/// dark-channel positions. Faithful to
/// `raw_core::stages::dehaze::atmospheric_light` — INCLUDING the exact
/// `sort_unstable_by` descending comparator (tie-breaks must match: on a small
/// image `top_n` is tiny, so one swapped pixel shifts A enough to fail parity).
fn atmospheric_light(pixels: &[[f32; 3]], dc: &[f32]) -> [f32; 3] {
    let n = dc.len();
    let top_n = (n / 1000).max(1);
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_unstable_by(|&a, &b| {
        dc[b]
            .partial_cmp(&dc[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut sum = [0.0f32; 3];
    for &i in &idx[..top_n] {
        let p = pixels[i];
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
    }
    let k = top_n as f32;
    [sum[0] / k, sum[1] / k, sum[2] / k]
}

/// Transmission: `1 - ω·(15×15 window min of min(rgb/A))`, clamp-to-edge, with
/// each A floored at 1e-6. Faithful to `raw_core::stages::dehaze::transmission`.
fn transmission(pixels: &[[f32; 3]], w: usize, h: usize, a: [f32; 3]) -> Vec<f32> {
    let wi = w as i32;
    let hi = h as i32;
    let r = DARK_RADIUS as i32;
    let mut out = vec![0.0f32; w * h];
    for y in 0..hi {
        for x in 0..wi {
            let mut m = f32::INFINITY;
            for dy in -r..=r {
                for dx in -r..=r {
                    let ux = (x + dx).clamp(0, wi - 1) as usize;
                    let uy = (y + dy).clamp(0, hi - 1) as usize;
                    let p = pixels[uy * w + ux];
                    let scaled_min = (p[0] / a[0].max(A_FLOOR))
                        .min(p[1] / a[1].max(A_FLOOR))
                        .min(p[2] / a[2].max(A_FLOOR));
                    if scaled_min < m {
                        m = scaled_min;
                    }
                }
            }
            out[(y * wi + x) as usize] = 1.0 - OMEGA * m;
        }
    }
    out
}

/// Separable box blur (shrinking partial average) — faithful to
/// `raw_core::stages::dehaze::box_blur` (the same running accumulator as
/// clarity's `box_blur_channel`). `r` here is always > 0 in the dehaze path.
fn box_blur(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; buf.len()];
    for y in 0..h {
        let row = &buf[y * w..(y + 1) * w];
        let out_row = &mut tmp[y * w..(y + 1) * w];
        let right0 = r.min(w - 1);
        let mut acc: f32 = row[0..=right0].iter().sum();
        let mut count = right0 + 1;
        out_row[0] = acc / count as f32;
        for x in 1..w {
            if x + r < w {
                acc += row[x + r];
                count += 1;
            }
            if x > r {
                acc -= row[x - r - 1];
                count -= 1;
            }
            out_row[x] = acc / count as f32;
        }
    }
    let mut out = vec![0.0f32; buf.len()];
    for x in 0..w {
        let bot0 = r.min(h - 1);
        let mut acc: f32 = (0..=bot0).map(|i| tmp[i * w + x]).sum();
        let mut count = bot0 + 1;
        out[x] = acc / count as f32;
        for y in 1..h {
            if y + r < h {
                acc += tmp[(y + r) * w + x];
                count += 1;
            }
            if y > r {
                acc -= tmp[(y - r - 1) * w + x];
                count -= 1;
            }
            out[y * w + x] = acc / count as f32;
        }
    }
    out
}

#[derive(Clone, Copy)]
struct GuidedFilterConfig {
    w: usize,
    h: usize,
    r: usize,
    eps: f32,
}

/// GENERAL guided filter (guide != p) — faithful to
/// `raw_core::stages::dehaze::guided_filter`. Six box blurs over the cross terms.
fn guided_filter(guide: &[f32], p: &[f32], config: GuidedFilterConfig) -> Vec<f32> {
    let GuidedFilterConfig { w, h, r, eps } = config;
    let n = guide.len();
    let mean_i = box_blur(guide, w, h, r);
    let mean_p = box_blur(p, w, h, r);
    let ip: Vec<f32> = guide.iter().zip(p.iter()).map(|(&a, &b)| a * b).collect();
    let mean_ip = box_blur(&ip, w, h, r);
    let ii: Vec<f32> = guide.iter().map(|&a| a * a).collect();
    let mean_ii = box_blur(&ii, w, h, r);

    let cov_ip: Vec<f32> = (0..n).map(|i| mean_ip[i] - mean_i[i] * mean_p[i]).collect();
    let var_i: Vec<f32> = (0..n).map(|i| mean_ii[i] - mean_i[i] * mean_i[i]).collect();
    let a: Vec<f32> = (0..n).map(|i| cov_ip[i] / (var_i[i] + eps)).collect();
    let b: Vec<f32> = (0..n).map(|i| mean_p[i] - a[i] * mean_i[i]).collect();

    let mean_a = box_blur(&a, w, h, r);
    let mean_b = box_blur(&b, w, h, r);
    (0..n).map(|i| mean_a[i] * guide[i] + mean_b[i]).collect()
}

/// `smoothstep(edge0, edge1, x)` — faithful to raw-core's helper / the WGSL builtin.
#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Sky mask: `smoothstep(0.40, 0.60, dc)` then a radius-8 box blur. Faithful to
/// `raw_core::stages::dehaze::sky_mask`.
fn sky_mask(dc: &[f32], w: usize, h: usize) -> Vec<f32> {
    let raw: Vec<f32> = dc
        .iter()
        .map(|&v| smoothstep(SKY_MASK_LOW, SKY_MASK_HIGH, v))
        .collect();
    box_blur(&raw, w, h, SKY_MASK_BLUR_RADIUS as usize)
}

/// The per-pixel recovery + sky-mask blend. Faithful to
/// `raw_core::stages::dehaze::recover_with_mask` (RAW A in the recovery divide).
fn recover_with_mask(
    pixels: &mut [[f32; 3]],
    dehaze: f32,
    t_refined: &[f32],
    a: [f32; 3],
    mask: &[f32],
) {
    let scale = (dehaze / 100.0).clamp(-1.0, 1.0);
    for (i, p) in pixels.iter_mut().enumerate() {
        let t = t_refined[i].clamp(0.0, 1.0);
        let (j_r, j_g, j_b) = if scale >= 0.0 {
            let t_eff = (t + (1.0 - t) * (1.0 - scale)).max(T0);
            (
                (p[0] - a[0]) / t_eff + a[0],
                (p[1] - a[1]) / t_eff + a[1],
                (p[2] - a[2]) / t_eff + a[2],
            )
        } else {
            let t_haze = 1.0 - (-scale) * (1.0 - t);
            let veil = 1.0 - t_haze;
            (
                p[0] * t_haze + a[0] * veil,
                p[1] * t_haze + a[1] * veil,
                p[2] * t_haze + a[2] * veil,
            )
        };
        let m = mask[i].clamp(0.0, 1.0);
        let inv_m = 1.0 - m;
        *p = [
            inv_m * j_r + m * p[0],
            inv_m * j_g + m * p[1],
            inv_m * j_b + m * p[2],
        ];
    }
}

/// Compute the atmospheric light A for `buf` (interleaved RGBA f32) EXACTLY as
/// `raw_core::stages::dehaze::apply` does: the dark channel, then the mean of the
/// original RGB at the brightest top-0.1% of dark-channel positions. Public so
/// [`DehazePass`] can run this global reduction CPU-side and pass A into the
/// kernels as a uniform (the cleanest headless-parity path for a global
/// reduction). The returned A is RAW (unclamped); the per-channel 1e-6 floor is
/// the transmission kernel's concern only.
pub fn compute_airlight(buf: &[f32], width: usize, height: usize) -> [f32; 3] {
    let pixels = to_rgb(buf);
    let dc = dark_channel(&pixels, width, height);
    atmospheric_light(&pixels, &dc)
}

/// Convert an interleaved RGBA f32 buffer to `[[f32;3]]` (drop alpha).
fn to_rgb(buf: &[f32]) -> Vec<[f32; 3]> {
    buf.chunks_exact(4).map(|c| [c[0], c[1], c[2]]).collect()
}

/// The CPU oracle: dehaze an interleaved RGBA f32 buffer (alpha untouched), a
/// line-for-line port of `raw_core::stages::dehaze::apply`. `dehaze` in
/// [-100, +100]; the `|dehaze| < 1e-3` no-op short-circuit is handled here as in
/// raw-core. `width × height` must equal `buf.len() / 4`.
pub fn apply_dehaze(buf: &mut [f32], width: usize, height: usize, dehaze: f32) {
    assert_eq!(
        buf.len(),
        width * height * 4,
        "dehaze oracle: buffer/dims mismatch"
    );
    if dehaze.abs() < 1e-3 {
        return;
    }
    let mut pixels = to_rgb(buf);

    let dc = dark_channel(&pixels, width, height);
    let a = atmospheric_light(&pixels, &dc);
    let t_raw = transmission(&pixels, width, height, a);

    let guide: Vec<f32> = pixels
        .iter()
        .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
        .collect();
    let t_refined = guided_filter(
        &guide,
        &t_raw,
        GuidedFilterConfig {
            w: width,
            h: height,
            r: GUIDED_RADIUS as usize,
            eps: GUIDED_EPS,
        },
    );

    let sky = sky_mask(&dc, width, height);
    recover_with_mask(&mut pixels, dehaze, &t_refined, a, &sky);

    for (i, p) in pixels.iter().enumerate() {
        buf[i * 4] = p[0];
        buf[i * 4 + 1] = p[1];
        buf[i * 4 + 2] = p[2];
        // alpha (buf[i*4+3]) untouched
    }
}

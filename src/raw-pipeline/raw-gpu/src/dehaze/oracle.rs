//! Dehaze's CPU oracle (epic #925 P2 wave 3b / #990) — split from `dehaze.rs` for
//! the file-size budget. A faithful port of `raw_core::stages::dehaze`: the
//! haze map measured on the fixed proxy grid (#3287 — `resample`, the 15×15
//! window minimum, `atmospheric_light`, the guided-filter coefficients and the
//! sky mask) and the bilinear-sampled per-pixel recovery, plus the public entry
//! points [`apply_dehaze`] (the full-stage oracle) and [`compute_airlight`] (the
//! global atmospheric-light reduction on the proxy grid, byte-exact vs raw-core).
//! The dehaze parity test (`dehaze/tests.rs`) pins this oracle — and
//! transitively the GPU kernels — to the REAL `raw_core::stages::dehaze::apply`,
//! so a transcription slip here cannot mask a kernel bug. Shares the stage
//! constants from the parent via `use super::*`.

use super::*;

fn to_rgb(buf: &[f32]) -> Vec<[f32; 3]> {
    buf.chunks_exact(4).map(|c| [c[0], c[1], c[2]]).collect()
}

fn span(i: usize, src: usize, dst: usize) -> (usize, usize) {
    let start = i * src / dst;
    (start, ((i + 1) * src / dst).max(start + 1))
}

fn resample(pixels: &[[f32; 3]], w: usize, h: usize, pw: usize, ph: usize) -> Vec<[f32; 3]> {
    let mut out = vec![[0.0f32; 3]; pw * ph];
    for j in 0..ph {
        let (y0, y1) = span(j, h, ph);
        for i in 0..pw {
            let (x0, x1) = span(i, w, pw);
            let mut sum = [0.0f32; 3];
            for y in y0..y1 {
                for p in &pixels[y * w + x0..y * w + x1] {
                    sum[0] += p[0];
                    sum[1] += p[1];
                    sum[2] += p[2];
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f32;
            out[j * pw + i] = [sum[0] / n, sum[1] / n, sum[2] / n];
        }
    }
    out
}

fn window_min(values: &[f32], w: usize, h: usize) -> Vec<f32> {
    let r = DARK_RADIUS;
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut m = f32::INFINITY;
            for yy in y.saturating_sub(r)..=(y + r).min(h - 1) {
                for xx in x.saturating_sub(r)..=(x + r).min(w - 1) {
                    m = m.min(values[yy * w + xx]);
                }
            }
            out[y * w + x] = m;
        }
    }
    out
}

fn atmospheric_light(pixels: &[[f32; 3]], dc: &[f32]) -> [f32; 3] {
    let n = dc.len();
    let top_n = (n / 1000).max(1);
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|a, b| dc[*b].total_cmp(&dc[*a]).then(a.cmp(b)));
    let sum = idx[..top_n].iter().fold([0.0f64; 3], |s, &i| {
        let p = pixels[i].map(f64::from);
        [s[0] + p[0], s[1] + p[1], s[2] + p[2]]
    });
    let k = top_n as f64;
    sum.map(|s| (s / k) as f32)
}

fn running_mean(line: &[f32], r: usize) -> Vec<f32> {
    let n = line.len();
    let right0 = r.min(n - 1);
    let mut acc: f64 = line[..=right0].iter().map(|&v| f64::from(v)).sum();
    let mut count = right0 + 1;
    let mut out = vec![(acc / count as f64) as f32];
    for x in 1..n {
        if x + r < n {
            acc += f64::from(line[x + r]);
            count += 1;
        }
        if x > r {
            acc -= f64::from(line[x - r - 1]);
            count -= 1;
        }
        out.push((acc / count as f64) as f32);
    }
    out
}

fn box_blur(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let rows: Vec<f32> = buf
        .chunks_exact(w)
        .flat_map(|row| running_mean(row, r))
        .collect();
    let mut out = vec![0.0f32; buf.len()];
    for x in 0..w {
        let column: Vec<f32> = (0..h).map(|y| rows[y * w + x]).collect();
        for (y, v) in running_mean(&column, r).into_iter().enumerate() {
            out[y * w + x] = v;
        }
    }
    out
}

fn guided_coefficients(guide: &[f32], p: &[f32], w: usize, h: usize) -> Vec<[f32; 2]> {
    let r = GUIDED_RADIUS as usize;
    let n = guide.len();
    let mean_i = box_blur(guide, w, h, r);
    let mean_p = box_blur(p, w, h, r);
    let ip: Vec<f32> = guide.iter().zip(p).map(|(&a, &b)| a * b).collect();
    let ii: Vec<f32> = guide.iter().map(|&a| a * a).collect();
    let mean_ip = box_blur(&ip, w, h, r);
    let mean_ii = box_blur(&ii, w, h, r);
    let (a, b): (Vec<f32>, Vec<f32>) = (0..n)
        .map(|k| {
            let cov = mean_ip[k] - mean_i[k] * mean_p[k];
            let var = (mean_ii[k] - mean_i[k] * mean_i[k]).max(0.0);
            let a = cov / (var + GUIDED_EPS);
            (a, mean_p[k] - a * mean_i[k])
        })
        .unzip();
    let mean_a = box_blur(&a, w, h, r);
    let mean_b = box_blur(&b, w, h, r);
    mean_a
        .into_iter()
        .zip(mean_b)
        .map(|(a, b)| [a, b])
        .collect()
}

#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn luma(p: [f32; 3]) -> f32 {
    LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2]
}

struct ProxyMap {
    pw: usize,
    ph: usize,
    airlight: [f32; 3],
    coefficients: Vec<[f32; 2]>,
    sky: Vec<f32>,
}

fn proxy_and_dark_channel(
    buf: &[f32],
    width: usize,
    height: usize,
) -> (Vec<[f32; 3]>, Vec<f32>, usize, usize) {
    let (pw, ph) = proxy_dims(width as u32, height as u32);
    let (pw, ph) = (pw as usize, ph as usize);
    let proxy = resample(&to_rgb(buf), width, height, pw, ph);
    let mins: Vec<f32> = proxy.iter().map(|p| p[0].min(p[1]).min(p[2])).collect();
    let dc = window_min(&mins, pw, ph);
    (proxy, dc, pw, ph)
}

fn measure(buf: &[f32], width: usize, height: usize) -> ProxyMap {
    let (proxy, dc, pw, ph) = proxy_and_dark_channel(buf, width, height);
    let a = atmospheric_light(&proxy, &dc);
    let scaled: Vec<f32> = proxy
        .iter()
        .map(|p| {
            (p[0] / a[0].max(A_FLOOR))
                .min(p[1] / a[1].max(A_FLOOR))
                .min(p[2] / a[2].max(A_FLOOR))
        })
        .collect();
    let t_raw: Vec<f32> = window_min(&scaled, pw, ph)
        .into_iter()
        .map(|m| 1.0 - OMEGA * m)
        .collect();
    let guide: Vec<f32> = proxy.iter().map(|&p| luma(p) - luma(a)).collect();
    let raw_sky: Vec<f32> = dc
        .iter()
        .map(|&v| smoothstep(SKY_MASK_LOW, SKY_MASK_HIGH, v))
        .collect();
    ProxyMap {
        pw,
        ph,
        airlight: a,
        coefficients: guided_coefficients(&guide, &t_raw, pw, ph),
        sky: box_blur(&raw_sky, pw, ph, SKY_MASK_BLUR_RADIUS as usize),
    }
}

fn axis_taps(index: usize, frame: usize, proxy: usize) -> (usize, usize, f32) {
    if frame == 0 || proxy == 0 {
        return (0, 0, 0.0);
    }
    let u = ((index as f32 + 0.5) * (proxy as f32 / frame as f32) - 0.5).max(0.0);
    let last = proxy - 1;
    let i0 = (u.floor() as usize).min(last);
    let i1 = (i0 + 1).min(last);
    (i0, i1, (u - i0 as f32).clamp(0.0, 1.0))
}

fn recover_pixel(p: [f32; 3], t: f32, a: [f32; 3], scale: f32, mask: f32) -> Option<[f32; 3]> {
    let t = t.clamp(0.0, 1.0);
    let j = if scale >= 0.0 {
        let point_min = (p[0] / a[0].max(A_FLOOR))
            .min(p[1] / a[1].max(A_FLOOR))
            .min(p[2] / a[2].max(A_FLOOR));
        let point_transmission = (1.0 - OMEGA * point_min).clamp(0.0, 1.0);
        let supported_t = t.max(point_transmission);
        if supported_t == 1.0 {
            return None;
        }
        let t_eff = (supported_t + (1.0 - supported_t) * (1.0 - scale)).max(T0);
        [0, 1, 2].map(|c| (p[c] - a[c]) / t_eff + a[c])
    } else {
        let t_haze = 1.0 - (-scale) * (1.0 - t);
        let veil = 1.0 - t_haze;
        [0, 1, 2].map(|c| p[c] * t_haze + a[c] * veil)
    };
    let m = mask.clamp(0.0, 1.0);
    let inv_m = 1.0 - m;
    Some([0, 1, 2].map(|c| inv_m * j[c] + m * p[c]))
}

/// The frame `buf` (`width × height` RGBA f32) block-averaged onto the haze
/// map's proxy grid, as RGBA f32, with the grid's dims.
#[cfg(test)]
pub(crate) fn proxy_rgba(buf: &[f32], width: usize, height: usize) -> (Vec<f32>, usize, usize) {
    let (pw, ph) = proxy_dims(width as u32, height as u32);
    let (pw, ph) = (pw as usize, ph as usize);
    let proxy = resample(&to_rgb(buf), width, height, pw, ph);
    (
        proxy.iter().flat_map(|p| [p[0], p[1], p[2], 1.0]).collect(),
        pw,
        ph,
    )
}

/// The atmospheric light A dehaze recovers with: measured on the proxy grid
/// of the frame `buf` (`width × height` RGBA f32), byte-exact vs raw-core;
/// an empty frame's identity map has A = 1.
pub fn compute_airlight(buf: &[f32], width: usize, height: usize) -> [f32; 3] {
    if width == 0 || height == 0 {
        return [1.0; 3];
    }
    let (proxy, dc, _, _) = proxy_and_dark_channel(buf, width, height);
    atmospheric_light(&proxy, &dc)
}

pub fn apply_dehaze(buf: &mut [f32], width: usize, height: usize, dehaze: f32) {
    assert_eq!(
        buf.len(),
        width * height * 4,
        "dehaze oracle: buffer/dims mismatch"
    );
    if dehaze.abs() < 1e-3 || width == 0 || height == 0 {
        return;
    }
    let map = measure(buf, width, height);
    let scale = (dehaze / 100.0).clamp(-1.0, 1.0);
    let bilerp =
        |plane: &dyn Fn(usize) -> f32, tx: (usize, usize, f32), ty: (usize, usize, f32)| {
            let at = |i: usize, j: usize| plane(j * map.pw + i);
            let top = at(tx.0, ty.0) + tx.2 * (at(tx.1, ty.0) - at(tx.0, ty.0));
            let bottom = at(tx.0, ty.1) + tx.2 * (at(tx.1, ty.1) - at(tx.0, ty.1));
            top + ty.2 * (bottom - top)
        };
    for y in 0..height {
        let ty = axis_taps(y, height, map.ph);
        for x in 0..width {
            let tx = axis_taps(x, width, map.pw);
            let k = (y * width + x) * 4;
            let p = [buf[k], buf[k + 1], buf[k + 2]];
            let a = bilerp(&|i| map.coefficients[i][0], tx, ty);
            let b = bilerp(&|i| map.coefficients[i][1], tx, ty);
            let m = bilerp(&|i| map.sky[i], tx, ty);
            let guide = luma(p) - luma(map.airlight);
            if let Some(out) = recover_pixel(p, a * guide + b, map.airlight, scale, m) {
                buf[k..k + 3].copy_from_slice(&out);
            }
        }
    }
}

use crate::image::{ColorSpace, Image};

const DARK_RADIUS: i32 = 7; // 15×15 neighborhood per spec § 3.9.

fn dark_channel(img: &Image) -> Vec<f32> {
    let w = img.width as i32;
    let h = img.height as i32;
    let mut out = vec![0.0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let mut m = f32::INFINITY;
            for dy in -DARK_RADIUS..=DARK_RADIUS {
                for dx in -DARK_RADIUS..=DARK_RADIUS {
                    let ux = (x + dx).clamp(0, w - 1) as usize;
                    let uy = (y + dy).clamp(0, h - 1) as usize;
                    let p = img.pixels[uy * (w as usize) + ux];
                    let local_min = p[0].min(p[1]).min(p[2]);
                    if local_min < m {
                        m = local_min;
                    }
                }
            }
            out[(y * w + x) as usize] = m;
        }
    }
    out
}

/// Atmospheric-light A: mean of the original image at the brightest 0.1% of
/// dark-channel positions (spec § 3.9 step 2). Returns the per-channel mean.
fn atmospheric_light(img: &Image, dc: &[f32]) -> [f32; 3] {
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
        let p = img.pixels[i];
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
    }
    let k = top_n as f32;
    [sum[0] / k, sum[1] / k, sum[2] / k]
}

/// Transmission estimate: `t(x,y) = 1 - ω * min over 15×15 of min(rgb/A)`.
/// ω = 0.95 per spec § 3.9 step 3.
fn transmission(img: &Image, a: [f32; 3]) -> Vec<f32> {
    const OMEGA: f32 = 0.95;
    let w = img.width as i32;
    let h = img.height as i32;
    let mut out = vec![0.0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let mut m = f32::INFINITY;
            for dy in -DARK_RADIUS..=DARK_RADIUS {
                for dx in -DARK_RADIUS..=DARK_RADIUS {
                    let ux = (x + dx).clamp(0, w - 1) as usize;
                    let uy = (y + dy).clamp(0, h - 1) as usize;
                    let p = img.pixels[uy * (w as usize) + ux];
                    let scaled_min = (p[0] / a[0].max(1e-6))
                        .min(p[1] / a[1].max(1e-6))
                        .min(p[2] / a[2].max(1e-6));
                    if scaled_min < m {
                        m = scaled_min;
                    }
                }
            }
            out[(y * w + x) as usize] = 1.0 - OMEGA * m;
        }
    }
    out
}

/// Separable box blur (radius `r`) on a single-channel buffer of dimensions w×h.
/// O(w*h) via running-sum; sufficient for slice 1 CPU path.
fn box_blur(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; buf.len()];
    // Horizontal pass: sliding window with truncated boundaries (no padding).
    for y in 0..h {
        let row = &buf[y * w..(y + 1) * w];
        let mut out_row = vec![0.0f32; w];
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
        tmp[y * w..(y + 1) * w].copy_from_slice(&out_row);
    }
    // Vertical pass: same sliding-window approach on the transposed result.
    let mut out = vec![0.0f32; buf.len()];
    for x in 0..w {
        let mut out_col = vec![0.0f32; h];
        let bot0 = r.min(h - 1);
        let mut acc: f32 = (0..=bot0).map(|i| tmp[i * w + x]).sum();
        let mut count = bot0 + 1;
        out_col[0] = acc / count as f32;
        for y in 1..h {
            if y + r < h {
                acc += tmp[(y + r) * w + x];
                count += 1;
            }
            if y > r {
                acc -= tmp[(y - r - 1) * w + x];
                count -= 1;
            }
            out_col[y] = acc / count as f32;
        }
        for y in 0..h {
            out[y * w + x] = out_col[y];
        }
    }
    out
}

#[derive(Copy, Clone, Debug)]
struct GuidedOptions {
    r: usize,
    eps: f32,
}

/// Guided filter (He, Sun, Tang 2010). Refines `p` using `guide` as an edge
/// reference. Spec § 3.9 step 4.
fn guided_filter(guide: &[f32], p: &[f32], w: usize, h: usize, opts: GuidedOptions) -> Vec<f32> {
    assert_eq!(guide.len(), p.len());
    let n = guide.len();

    let mean_i = box_blur(guide, w, h, opts.r);
    let mean_p = box_blur(p, w, h, opts.r);

    let ip: Vec<f32> = guide.iter().zip(p.iter()).map(|(&a, &b)| a * b).collect();
    let mean_ip = box_blur(&ip, w, h, opts.r);

    let cov_ip: Vec<f32> = mean_ip
        .iter()
        .zip(mean_i.iter().zip(mean_p.iter()))
        .map(|(&mip, (&mi, &mp))| mip - mi * mp)
        .collect();

    let ii: Vec<f32> = guide.iter().map(|&a| a * a).collect();
    let mean_ii = box_blur(&ii, w, h, opts.r);
    let var_i: Vec<f32> = mean_ii
        .iter()
        .zip(mean_i.iter())
        .map(|(&mii, &mi)| mii - mi * mi)
        .collect();

    let a: Vec<f32> = cov_ip
        .iter()
        .zip(var_i.iter())
        .map(|(&cip, &vi)| cip / (vi + opts.eps))
        .collect();
    let b: Vec<f32> = (0..n).map(|i| mean_p[i] - a[i] * mean_i[i]).collect();

    let mean_a = box_blur(&a, w, h, opts.r);
    let mean_b = box_blur(&b, w, h, opts.r);

    (0..n).map(|i| mean_a[i] * guide[i] + mean_b[i]).collect()
}

/// "Sky / no-dark-pixel" mask thresholds (issue #272).
///
/// The dark-channel-prior assumption — every patch contains at least one
/// channel with a low value — breaks on sky, snow, and white walls. In those
/// regions every channel is high, so the dark channel itself is high, the
/// transmission collapses toward 0, and `J = (I − A) / t + A` produces strong
/// halos at the sky / foreground boundary.
///
/// We use the dark channel as a sky detector: when `dc(x,y)` exceeds
/// `SKY_MASK_LOW`, the pixel is increasingly likely to be sky-like. We
/// smoothstep from `SKY_MASK_LOW` to `SKY_MASK_HIGH` so the mask feathers
/// rather than snapping. At positions with `mask = 1` the dehaze recovery is
/// fully suppressed; the input is passed through unchanged.
///
/// Threshold rationale (scene-linear Rec.2020, post-exposure):
/// - Below 0.40 dc: typical hazy mid-distance content (rocks, foliage,
///   buildings, water with foam). DCP works here — leave it alone.
/// - 0.40 – 0.60 dc: ambiguous (bright haze, distant snow, light walls).
///   Soft-feather so we don't introduce visible boundaries.
/// - Above 0.60 dc: clear sky or white wall — DCP is unreliable, suppress
///   the dehaze contribution entirely.
const SKY_MASK_LOW: f32 = 0.40;
const SKY_MASK_HIGH: f32 = 0.60;

/// Box-blur radius for the sky mask. Lower than the guided-filter radius
/// because the mask only needs to be smooth, not edge-aware — the mask
/// already came from dark-channel min-filtering, which is conservative at
/// boundaries.
const SKY_MASK_BLUR_RADIUS: usize = 8;

/// `smoothstep(edge0, edge1, x)` — cubic Hermite interpolation matching
/// the GLSL builtin. Returns 0 below `edge0`, 1 above `edge1`.
#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Build a per-pixel "sky" mask in [0, 1] from the dark channel. Then
/// box-blur it lightly to soften pixel-noise in the transition band.
fn sky_mask(dc: &[f32], w: usize, h: usize) -> Vec<f32> {
    let raw: Vec<f32> = dc
        .iter()
        .map(|&v| smoothstep(SKY_MASK_LOW, SKY_MASK_HIGH, v))
        .collect();
    box_blur(&raw, w, h, SKY_MASK_BLUR_RADIUS)
}

/// Apply dehaze per spec § 3.9.
/// `dehaze` in [-100, +100]; 0 is identity.
///
/// Positive slider strengthens haze removal (transmission mapped toward its
/// recovered value); negative adds haze (transmission pushed toward 1.0).
/// The final recovery `J = (I - A) / max(t, t0) + A` uses a transmission
/// floor t0 = 0.1 to avoid division-blowup on the darkest patches.
///
/// A sky mask (issue #272) suppresses the dehaze contribution where the
/// DCP assumption fails (sky, snow, white walls). See `SKY_MASK_LOW` /
/// `SKY_MASK_HIGH` above for the threshold and feathering rationale.
pub fn apply(img: &mut Image, dehaze: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if dehaze.abs() < 1e-3 {
        return;
    }
    let w = img.width as usize;
    let h = img.height as usize;

    let dc = dark_channel(img);
    let a = atmospheric_light(img, &dc);
    let t_raw = transmission(img, a);

    // Build a single-channel "guide" from scene-linear luminance.
    // Rec.2020 weights per spec § 3.6.
    let guide: Vec<f32> = img
        .pixels
        .iter()
        .map(|p| 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2])
        .collect();
    let t_refined = guided_filter(&guide, &t_raw, w, h, GuidedOptions { r: 60, eps: 1e-3 });

    // Sky / no-dark-pixel mask: keep DCP where it works, suppress where it
    // doesn't. Cheap — one smoothstep per pixel + one box-blur pass.
    let sky = sky_mask(&dc, w, h);

    recover_with_mask(img, dehaze, &t_refined, a, &sky);
}

/// Recovery loop split out for testability. `apply` calls this with the real
/// sky mask; tests can call it with a zero-mask buffer to verify the mask is
/// load-bearing (without it, the sky-preservation property fails).
fn recover_with_mask(img: &mut Image, dehaze: f32, t_refined: &[f32], a: [f32; 3], mask: &[f32]) {
    let t0 = 0.1f32;
    let scale = (dehaze / 100.0).clamp(-1.0, 1.0);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        let t = t_refined[i].clamp(0.0, 1.0);
        let t_eff = if scale >= 0.0 {
            // Positive: linearly blend from "no haze removal" (t=1) toward
            // the recovered transmission.
            (t + (1.0 - t) * (1.0 - scale)).max(t0)
        } else {
            // Negative: push transmission toward 1 (adds haze).
            (t + (1.0 - t) * (-scale)).min(1.0).max(t0)
        };
        let j_r = (p[0] - a[0]) / t_eff + a[0];
        let j_g = (p[1] - a[1]) / t_eff + a[1];
        let j_b = (p[2] - a[2]) / t_eff + a[2];
        // Blend dehaze result `J` with the unmodified input `I` by the sky
        // mask: mask=1 → input, mask=0 → full dehaze.
        let m = mask[i].clamp(0.0, 1.0);
        let inv_m = 1.0 - m;
        *p = [
            inv_m * j_r + m * p[0],
            inv_m * j_g + m * p[1],
            inv_m * j_b + m * p[2],
        ];
    }
}

/// Test-only entry that mirrors `apply` but with a caller-supplied mask buffer.
/// Used by `dehaze_preserves_sky_attacks_haze` to verify that the sky mask is
/// load-bearing — when passed a zero mask, the sky-preservation assertion
/// must fail (proving the mask is what makes it pass).
#[cfg(test)]
fn apply_with_mask_override(img: &mut Image, dehaze: f32, mask_override: &[f32]) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if dehaze.abs() < 1e-3 {
        return;
    }
    let w = img.width as usize;
    let h = img.height as usize;
    let dc = dark_channel(img);
    let a = atmospheric_light(img, &dc);
    let t_raw = transmission(img, a);
    let guide: Vec<f32> = img
        .pixels
        .iter()
        .map(|p| 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2])
        .collect();
    let t_refined = guided_filter(&guide, &t_raw, w, h, GuidedOptions { r: 60, eps: 1e-3 });
    assert_eq!(mask_override.len(), (w * h));
    recover_with_mask(img, dehaze, &t_refined, a, mask_override);
}

// Tests live in the sibling `dehaze_tests.rs` so this file stays under the
// 600-LOC budget (same `#[path]` split pattern as `stages/nlm.rs`).
#[cfg(test)]
#[path = "dehaze_tests.rs"]
mod tests;

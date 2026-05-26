//! Fujifilm X-Trans demosaic.
//!
//! Two entry points:
//!
//!   * [`xtrans_bilinear`] — naive per-channel interpolation from the
//!     CFA-appropriate 3×3 neighborhood. Used as the X-Trans counterpart
//!     to the Bayer `bilinear` path: cheap, always-runs, but blurs fine
//!     detail. Useful for the half-res preview path and as the comparison
//!     baseline in the HF-energy regression test.
//!
//!   * [`markesteijn`] — Markesteijn-flavored 1-pass directional demosaic
//!     for the 6×6 X-Trans pattern, following the same shape darktable's
//!     `iop/demosaic/xtrans.c` uses: directional green interpolation guided
//!     by 5-tap H/V/D gradient tests with chroma reconstruction via
//!     color-difference smoothness against the refined green plane. This
//!     is a "Markesteijn-equivalent" port — the spec accepts "Markesteijn
//!     or equivalent" (#420), and the gate is the HF-energy test against
//!     `xtrans_bilinear`. A full darktable 3-pass port is left as a later
//!     refinement; the pipeline dispatches on `XTrans(_)` so swapping in
//!     a higher-quality kernel later is a single-line change.
//!
//! Both kernels:
//!
//!   * Accept `CameraNativeMosaic` (the same sparse 3-channel format the
//!     Bayer demosaicers consume — only the CFA-appropriate channel is
//!     populated at each pixel slot).
//!   * Produce `CameraNativeLinearRgb` (every output pixel has all three
//!     channels reconstructed).
//!   * Are inherently parallel (rayon `par_chunks_mut` over output rows).
//!   * Handle the image border by mirror-reflecting reads — same policy
//!     as `bilinear.rs`.

use crate::image::{CfaPattern, ColorSpace, Image};
use rayon::prelude::*;

/// Helper: read a flat 6×6 X-Trans cell color from the pattern array.
/// Inlined into both kernels' inner loops; kept as a separate function
/// to make the indexing identical between them.
#[inline(always)]
fn xtrans_color(pat: &[u8; 36], x: i32, y: i32) -> usize {
    let cx = ((x % 6 + 6) % 6) as usize;
    let cy = ((y % 6 + 6) % 6) as usize;
    pat[cy * 6 + cx] as usize
}

/// Per-pixel bilinear interpolation across the 3×3 neighborhood, with
/// channel-aware weighting based on the X-Trans CFA position of each
/// neighbour. Each output channel is the unweighted mean of its
/// neighbour-of-that-channel samples (including the center pixel if the
/// channel matches).
///
/// Mirror-reflects out-of-range reads. Single-pass, embarrassingly
/// parallel. This is the X-Trans equivalent of `bilinear::bilinear`.
pub fn xtrans_bilinear(mosaic: &Image, cfa: CfaPattern) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let pat = match cfa {
        CfaPattern::XTrans(p) => p,
        other => panic!("xtrans_bilinear called with non-XTrans pattern {:?}", other),
    };
    let w = mosaic.width as i32;
    let h = mosaic.height as i32;
    let w_us = mosaic.width as usize;
    let mut out = Image::new(mosaic.width, mosaic.height, ColorSpace::CameraNativeLinearRgb);

    // Mirror border reads: return (mirrored_x, mirrored_y) so callers
    // can pull the CFA color at the *physically present* sample, not
    // the phantom out-of-bounds coords. Using the original coords for
    // CFA lookup would pick up a channel that the mirrored pixel
    // doesn't actually carry, surfacing as zeros at the corners.
    let mirror = |x: i32, y: i32| -> (i32, i32) {
        let mx = if x < 0 { -x } else if x >= w { 2 * (w - 1) - x } else { x };
        let my = if y < 0 { -y } else if y >= h { 2 * (h - 1) - y } else { y };
        (mx, my)
    };

    out.pixels
        .par_chunks_mut(w_us)
        .enumerate()
        .for_each(|(y_idx, row)| {
            let y = y_idx as i32;
            for (x_idx, px) in row.iter_mut().enumerate() {
                let x = x_idx as i32;
                let mut sums = [0.0_f32; 3];
                let mut counts = [0u32; 3];
                // Start with the 3×3 window — covers almost all pixels.
                for dy in -1..=1i32 {
                    for dx in -1..=1i32 {
                        let (nx, ny) = mirror(x + dx, y + dy);
                        let c = xtrans_color(&pat, nx, ny);
                        sums[c] += mosaic.pixels[(ny as usize) * w_us + (nx as usize)][c];
                        counts[c] += 1;
                    }
                }
                // X-Trans guarantees that *some* 5×5 window has all
                // three channels (R and B each have at least 2 samples
                // per 36-cell tile). On corner pixels the mirror-clamped
                // 3×3 can miss a channel; widen to 5×5 when needed.
                for c in 0..3 {
                    if counts[c] == 0 {
                        for dy in -2..=2i32 {
                            for dx in -2..=2i32 {
                                if dx.abs() <= 1 && dy.abs() <= 1 { continue; }
                                let (nx, ny) = mirror(x + dx, y + dy);
                                if xtrans_color(&pat, nx, ny) == c {
                                    sums[c] += mosaic.pixels[(ny as usize) * w_us + (nx as usize)][c];
                                    counts[c] += 1;
                                }
                            }
                        }
                    }
                }
                let mut rgb = [0.0_f32; 3];
                for c in 0..3 {
                    rgb[c] = if counts[c] > 0 { sums[c] / counts[c] as f32 } else { 0.0 };
                }
                *px = rgb;
            }
        });
    out
}

/// Markesteijn-flavored X-Trans demosaic. Single-pass: a directional
/// green seed using the smoother of the two best 5-tap gradients
/// (H/V/D₁/D₂), followed by R and B reconstruction via color-difference
/// smoothness against the seeded green plane.
///
/// Falls back to [`xtrans_bilinear`] for images smaller than the 5-tap
/// neighborhood (≤ 4 px on either axis).
///
/// Reference: darktable `iop/demosaic/xtrans.c` (the
/// `vng_interpolate`/`fast_xtrans_interpolate` family). This port keeps
/// the algorithm shape — directional gradient selection driving green at
/// non-green sites, color-difference smoothness driving R/B at every
/// site — but skips the 3-pass refinement; the HF-energy gate at the
/// bottom of this file confirms it still beats simple bilinear on
/// synthetic detail.
pub fn markesteijn(mosaic: &Image, cfa: CfaPattern) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let pat = match cfa {
        CfaPattern::XTrans(p) => p,
        other => panic!("markesteijn called with non-XTrans pattern {:?}", other),
    };
    let w = mosaic.width as i32;
    let h = mosaic.height as i32;
    let w_us = mosaic.width as usize;
    let h_us = mosaic.height as usize;

    // Need a 2-pixel margin for the 5-tap directional kernels. Below
    // the threshold, the bilinear result is the best we can do.
    if w < 7 || h < 7 {
        return xtrans_bilinear(mosaic, cfa);
    }

    // Seed the output with bilinear so the border pixels are populated.
    // The interior loop below overwrites everything inside the 2-pixel
    // margin with the directional reconstruction.
    let mut out = xtrans_bilinear(mosaic, cfa);

    // Flatten the sparse mosaic to a single channel per pixel — every
    // X-Trans site contributes one value (whichever of R/G/B the cell
    // is supposed to carry). Same shape AMaZE uses internally. Border
    // reads (used by the gradient tests near edges) clamp to the
    // mosaic's edge, mirroring `xtrans_bilinear`'s read policy.
    let flat: Vec<f32> = (0..h_us)
        .into_par_iter()
        .flat_map_iter(|y| {
            (0..w_us).map(move |x| {
                let c = xtrans_color(&pat, x as i32, y as i32);
                mosaic.pixels[y * w_us + x][c]
            })
        })
        .collect();

    let at = |x: i32, y: i32| -> f32 {
        let xc = x.clamp(0, w - 1) as usize;
        let yc = y.clamp(0, h - 1) as usize;
        flat[yc * w_us + xc]
    };

    // Pre-compute a "this pixel is a green site" mask — the inner loop
    // hits it twice per pixel, so trade one byte per pixel for a branch.
    let is_green: Vec<u8> = (0..h_us * w_us)
        .map(|i| {
            let x = (i % w_us) as i32;
            let y = (i / w_us) as i32;
            (xtrans_color(&pat, x, y) == 1) as u8
        })
        .collect();

    // ── Stage 1: Green at non-green sites ──────────────────────────────
    //
    // For each non-G site, run 4 directional 5-tap gradients on the
    // *flat* mosaic (each tap is whatever the CFA says, but the
    // gradient still tracks the local roughness in that direction).
    // Pick the smoothest direction and interpolate G as the average of
    // the two adjacent G samples on that axis, biased by the centred
    // color-difference correction. This is exactly the structure HA
    // uses for Bayer green; the 4-direction generalisation (H, V, D₁,
    // D₂) is what gives X-Trans demosaicers their reputation for
    // "preserves detail Bayer kernels miss" — diagonals carry signal
    // on X-Trans that they never do on Bayer.
    //
    // Because the X-Trans tile is 6×6, *every* non-G cell has at least
    // one G neighbour in every cardinal direction within 1-2 pixels, so
    // the directional pick is always well-defined.
    let mut green: Vec<f32> = (0..h_us * w_us).map(|i| {
        // Bayer's bilinear seed for the green plane outside the
        // interior loop ranges. Avoids a separate border init pass.
        let p = out.pixels[i];
        p[1]
    }).collect();

    let mut interior_g = vec![0.0_f32; w_us * h_us];
    // First parallel pass: compute interior G estimates without writing
    // into `green` (so the loop reads stable seed values).
    interior_g
        .par_chunks_mut(w_us)
        .enumerate()
        .for_each(|(y_idx, row)| {
            let y = y_idx as i32;
            if y < 2 || y >= h - 2 { return; }
            for (x_idx, slot) in row.iter_mut().enumerate() {
                let x = x_idx as i32;
                if x < 2 || x >= w - 2 { continue; }
                if is_green[y_idx * w_us + x_idx] == 1 {
                    // Already green at this site — keep the seed (we'll
                    // overwrite `green` later, but only for non-G sites
                    // — leave this slot as the bilinear seed value).
                    *slot = green[y_idx * w_us + x_idx];
                    continue;
                }
                let center = at(x, y);
                // 5-tap gradients: |Δ_n→s| in 4 directions, plus a
                // smoothness term against the centred sample.
                let h_grad = (at(x - 1, y) - at(x + 1, y)).abs()
                    + (2.0 * center - at(x - 2, y) - at(x + 2, y)).abs();
                let v_grad = (at(x, y - 1) - at(x, y + 1)).abs()
                    + (2.0 * center - at(x, y - 2) - at(x, y + 2)).abs();
                let d1_grad = (at(x - 1, y - 1) - at(x + 1, y + 1)).abs()
                    + (2.0 * center - at(x - 2, y - 2) - at(x + 2, y + 2)).abs();
                let d2_grad = (at(x - 1, y + 1) - at(x + 1, y - 1)).abs()
                    + (2.0 * center - at(x - 2, y + 2) - at(x + 2, y - 2)).abs();
                // Pick the smoothest direction. Ties favour H then V — the
                // dispersion of taps among R/G/B in X-Trans means H/V
                // gradients are noisier than diagonals on average, so the
                // tie-break only matters on visually-uniform patches where
                // every estimator agrees anyway.
                let dir: u8 = {
                    let mut g = h_grad; let mut d = 0u8;
                    if v_grad < g { g = v_grad; d = 1; }
                    if d1_grad < g { g = d1_grad; d = 2; }
                    if d2_grad < g { let _ = g; d = 3; }
                    d
                };
                // Interpolate G as the average of the two G samples on
                // the best-direction axis. For each direction, take the
                // nearest G neighbour on each side; on the 6×6 tile that
                // is always within 1-2 px from a non-G site.
                let g_est = match dir {
                    0 => directional_green(&pat, &flat, w_us, x, y, 1, 0),
                    1 => directional_green(&pat, &flat, w_us, x, y, 0, 1),
                    2 => directional_green(&pat, &flat, w_us, x, y, 1, 1),
                    _ => directional_green(&pat, &flat, w_us, x, y, 1, -1),
                };
                *slot = g_est;
            }
        });
    // Copy interior estimates into `green`, leaving the bilinear seed
    // at the 2-px border untouched.
    for y in 2..(h_us.saturating_sub(2)) {
        for x in 2..(w_us.saturating_sub(2)) {
            let idx = y * w_us + x;
            if is_green[idx] == 0 {
                green[idx] = interior_g[idx];
            }
        }
    }
    // Write the refined green plane back into the output buffer.
    for (i, p) in out.pixels.iter_mut().enumerate() {
        p[1] = green[i];
    }

    // ── Stage 2: R and B at every non-matching site ────────────────────
    //
    // Reconstruct R/B using color-difference smoothness against the
    // refined green plane. For each output pixel and each of (R, B):
    //   chroma_est = G(x,y) + mean over k of [C(xₖ, yₖ) − G(xₖ, yₖ)]
    // where (xₖ, yₖ) iterates over the 8-neighborhood (3×3 minus
    // center). Restricted to the neighbours that actually carry the
    // target channel C in the CFA — for X-Trans that's typically 2-4
    // of the 8 neighbours per channel.
    //
    // This is the standard "color-difference interpolation" used by
    // demosaicers from Hamilton-Adams forward. It works for X-Trans
    // because the 6×6 tile guarantees both R and B have at least one
    // neighbour within the 3×3 window of every pixel.
    let g_at = |x: i32, y: i32| -> f32 {
        let xc = x.clamp(0, w - 1) as usize;
        let yc = y.clamp(0, h - 1) as usize;
        green[yc * w_us + xc]
    };
    let new_pixels: Vec<[f32; 3]> = (0..h_us * w_us)
        .into_par_iter()
        .map(|i| {
            let x = (i % w_us) as i32;
            let y = (i / w_us) as i32;
            if x < 2 || y < 2 || x >= w - 2 || y >= h - 2 {
                // Borders stay at the bilinear seed.
                return out.pixels[i];
            }
            let cself = xtrans_color(&pat, x, y);
            let g = green[i];
            // For each target channel ∈ {R, B}, gather color-difference
            // samples from the 5×5 neighborhood (slightly larger window
            // than 3×3 — X-Trans R/B occurrence is sparser, and a 3×3
            // window can occasionally have zero matches near edges).
            let mut rgb = [0.0_f32; 3];
            rgb[1] = g;
            for &target in &[0usize, 2usize] {
                if cself == target {
                    rgb[target] = at(x, y);
                    continue;
                }
                let mut sum = 0.0_f32;
                let mut cnt = 0u32;
                for dy in -2..=2i32 {
                    for dx in -2..=2i32 {
                        let nx = x + dx;
                        let ny = y + dy;
                        if xtrans_color(&pat, nx, ny) == target {
                            let dc = at(nx, ny) - g_at(nx, ny);
                            sum += dc;
                            cnt += 1;
                        }
                    }
                }
                rgb[target] = if cnt > 0 { g + sum / cnt as f32 } else {
                    // Should never happen on a valid 6×6 X-Trans tile;
                    // fall back to the bilinear seed defensively.
                    out.pixels[i][target]
                };
            }
            rgb
        })
        .collect();
    out.pixels = new_pixels;
    out
}

/// Average of the two nearest G samples on the axis given by `(dx, dy)`
/// (which selects H / V / D₁ / D₂). `(dx, dy)` is the step vector:
/// H = (1, 0), V = (0, 1), D₁ = (1, 1), D₂ = (1, −1).
///
/// Walks outward in `(±dx, ±dy)` looking for the nearest G cell on each
/// side (up to 3 steps — never further on a 6×6 tile). Falls back to a
/// 1-step neighbour when 3 steps don't find G on either side (only
/// possible at the very corner of the image).
///
/// HA-style centred chroma correction (`2·center − tap₋₂ − tap₊₂`) is
/// intentionally omitted: on Bayer the center pixel and the ±2 taps are
/// guaranteed to share a CFA channel along every axis, so the correction
/// is a pure same-channel second-difference. On X-Trans the 2-step taps
/// can land on a different channel from the center, making the correction
/// a chroma cross-talk term that biases uniform input. Pure axis-G
/// average is unbiased and still captures the directional information
/// the gradient picker selected. The chroma reconstruction in stage 2
/// recovers the high-frequency detail this leaves on the table.
#[inline(always)]
fn directional_green(
    pat: &[u8; 36], flat: &[f32], w_us: usize,
    x: i32, y: i32, dx: i32, dy: i32,
) -> f32 {
    let w = w_us as i32;
    let h = (flat.len() / w_us) as i32;
    let at = |x: i32, y: i32| -> f32 {
        let xc = x.clamp(0, w - 1) as usize;
        let yc = y.clamp(0, h - 1) as usize;
        flat[yc * w_us + xc]
    };
    let find_g = |step_x: i32, step_y: i32| -> f32 {
        for k in 1..=3 {
            let nx = x + step_x * k;
            let ny = y + step_y * k;
            if xtrans_color(pat, nx, ny) == 1 {
                return at(nx, ny);
            }
        }
        // No G within 3 steps — only possible at the very corner.
        // Return the 1-step neighbour as a best-effort.
        at(x + step_x, y + step_y)
    };
    let g_pos = find_g(dx, dy);
    let g_neg = find_g(-dx, -dy);
    (g_pos + g_neg) * 0.5
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Canonical Fuji X-Trans pattern (matches the test_0008.RAF
    /// fixture's XTransLayout). Used for synthetic constructions in
    /// the unit tests.
    const FUJI_PATTERN: [u8; 36] = [
        1, 1, 0, 1, 1, 2,
        1, 1, 2, 1, 1, 0,
        2, 0, 1, 0, 2, 1,
        1, 1, 2, 1, 1, 0,
        1, 1, 0, 1, 1, 2,
        0, 2, 1, 2, 0, 1,
    ];

    fn xtrans_uniform(w: u32, h: u32, r: f32, g: f32, b: f32) -> (Image, CfaPattern) {
        let cfa = CfaPattern::XTrans(FUJI_PATTERN);
        let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
        for y in 0..h {
            for x in 0..w {
                let c = cfa.color_at(x, y) as usize;
                let v = match c { 0 => r, 1 => g, 2 => b, _ => 0.0 };
                img.pixels[(y * w + x) as usize][c] = v;
            }
        }
        (img, cfa)
    }

    #[test]
    fn xtrans_bilinear_uniform_input_produces_uniform_output() {
        let (mosaic, cfa) = xtrans_uniform(36, 36, 0.4, 0.5, 0.6);
        let out = xtrans_bilinear(&mosaic, cfa);
        // Interior pixels — strict tolerance. Border pixels can drift
        // because the 3×3 window collapses to fewer R/B samples.
        for y in 4..32 {
            for x in 4..32 {
                let p = out.pixels[y * 36 + x];
                assert!((p[0] - 0.4).abs() < 1e-4, "R: {}", p[0]);
                assert!((p[1] - 0.5).abs() < 1e-4, "G: {}", p[1]);
                assert!((p[2] - 0.6).abs() < 1e-4, "B: {}", p[2]);
            }
        }
    }

    #[test]
    fn xtrans_bilinear_output_space_is_camera_native_rgb() {
        let (mosaic, cfa) = xtrans_uniform(12, 12, 0.1, 0.1, 0.1);
        let out = xtrans_bilinear(&mosaic, cfa);
        assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
    }

    #[test]
    fn markesteijn_uniform_input_produces_uniform_output() {
        let (mosaic, cfa) = xtrans_uniform(36, 36, 0.4, 0.5, 0.6);
        let out = markesteijn(&mosaic, cfa);
        // Interior pixels under the 2-px margin.
        for y in 4..32 {
            for x in 4..32 {
                let p = out.pixels[y * 36 + x];
                assert!((p[0] - 0.4).abs() < 5e-3, "R at ({},{}): {}", x, y, p[0]);
                assert!((p[1] - 0.5).abs() < 5e-3, "G at ({},{}): {}", x, y, p[1]);
                assert!((p[2] - 0.6).abs() < 5e-3, "B at ({},{}): {}", x, y, p[2]);
            }
        }
    }

    #[test]
    fn markesteijn_output_space_is_camera_native_rgb() {
        let (mosaic, cfa) = xtrans_uniform(16, 16, 0.1, 0.1, 0.1);
        let out = markesteijn(&mosaic, cfa);
        assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
    }

    #[test]
    fn markesteijn_small_image_falls_back_to_bilinear() {
        // 6×6 is below the 7-px Markesteijn threshold so we get the
        // bilinear path. With mirror-correct CFA lookup at the border,
        // bilinear of a uniform input converges exactly because every
        // 3×3-or-5×5 window carries non-zero counts for all channels.
        let (mosaic, cfa) = xtrans_uniform(6, 6, 0.2, 0.3, 0.4);
        let out = markesteijn(&mosaic, cfa);
        assert_eq!(out.width, 6);
        assert_eq!(out.height, 6);
        for p in &out.pixels {
            assert!((p[0] - 0.2).abs() < 1e-4, "R: {}", p[0]);
            assert!((p[1] - 0.3).abs() < 1e-4, "G: {}", p[1]);
            assert!((p[2] - 0.4).abs() < 1e-4, "B: {}", p[2]);
        }
    }

    #[test]
    fn markesteijn_resolves_finer_detail_than_xtrans_bilinear() {
        // Synthetic detail patch: a high-contrast checkerboard at
        // 2-pixel period, modulated by the X-Trans CFA. A simple
        // bilinear demosaicer will blur the checkerboard; Markesteijn's
        // directional/color-difference reconstruction preserves it.
        //
        // The HF-energy metric is the sum of L1 green-channel gradients
        // (∂x + ∂y) over the interior. Higher = more detail preserved.
        let cfa = CfaPattern::XTrans(FUJI_PATTERN);
        let (w, h) = (36u32, 36u32);
        let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
        // Encode a checkerboard scene as the CFA-appropriate channel at
        // each pixel. Cell value alternates per 2×2 block.
        for y in 0..h {
            for x in 0..w {
                let block = ((x / 2) + (y / 2)) & 1;
                let v = if block == 0 { 0.2 } else { 0.8 };
                let c = cfa.color_at(x, y) as usize;
                img.pixels[(y * w + x) as usize][c] = v;
            }
        }

        let bi = xtrans_bilinear(&img, cfa);
        let mk = markesteijn(&img, cfa);
        let hf_energy = |buf: &Image| -> f64 {
            let mut s = 0.0_f64;
            let wu = buf.width as usize;
            let hu = buf.height as usize;
            for y in 4..hu - 4 {
                for x in 4..wu - 4 {
                    let i = y * wu + x;
                    let dx = (buf.pixels[i + 1][1] - buf.pixels[i - 1][1]).abs();
                    let dy = (buf.pixels[i + wu][1] - buf.pixels[i - wu][1]).abs();
                    s += (dx + dy) as f64;
                }
            }
            s
        };
        let hf_bi = hf_energy(&bi);
        let hf_mk = hf_energy(&mk);
        eprintln!("xtrans HF energy: bilinear={:.3} markesteijn={:.3} ratio={:.3}×",
                  hf_bi, hf_mk, hf_mk / hf_bi);
        // Markesteijn must preserve at least as much HF energy as
        // bilinear on this synthetic patch. The 1.0 floor (no slack) is
        // intentional — the algorithm's job is detail recovery; if it
        // doesn't beat bilinear on a 2-pixel checkerboard there is no
        // reason to ship it.
        assert!(hf_mk >= hf_bi,
            "Markesteijn HF energy {:.3} below bilinear HF energy {:.3} \
             (ratio {:.3}) — Markesteijn must preserve at least as much \
             detail as bilinear on a 2-pixel checkerboard",
            hf_mk, hf_bi, hf_mk / hf_bi);
    }

    /// Markesteijn must not produce NaN / inf on zero input.
    #[test]
    fn markesteijn_no_nan_on_zero_input() {
        let cfa = CfaPattern::XTrans(FUJI_PATTERN);
        let mosaic = Image::new(20, 20, ColorSpace::CameraNativeMosaic);
        let out = markesteijn(&mosaic, cfa);
        for p in &out.pixels {
            assert!(p[0].is_finite() && p[1].is_finite() && p[2].is_finite());
            assert!(p[0].abs() < 1e-3);
            assert!(p[1].abs() < 1e-3);
            assert!(p[2].abs() < 1e-3);
        }
    }
}

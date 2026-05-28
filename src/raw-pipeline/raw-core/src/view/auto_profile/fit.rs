//! Fit path: extract embedded JPEG → build CDF curves → fit matrix and
//! Oklab corrections.
//!
//! Split out of `mod.rs` to keep that file under the 600-LOC hard budget.

use std::path::Path;

use image::DynamicImage;

use crate::image::ExifOrientation;

use super::apply::compress_input;
use super::curve::{self, ProfileCurve, IDENTITY_MATRIX};
use super::matrix::solve_3x3_lsq;
use super::preview::{self, JpegColorSpace};

/// Fit a [`ProfileCurve`] from a RAW file's embedded JPEG preview against
/// Maple's intermediate linear Rec.2020 RGB buffer.
///
/// `source_rgb` is the caller's interleaved RGB f32 buffer in linear
/// Rec.2020 — i.e. the pipeline state just before the view transform —
/// laid out as `[r, g, b, r, g, b, ...]`. The fitted curves map this
/// distribution onto the JPEG preview's distribution (also in linear
/// Rec.2020 after sRGB decode + primary conversion).
///
/// Returns `None` if:
/// - JPEG extraction fails (file missing, format unsupported, decoder stub)
/// - Preview is too small (< 256 px on either edge)
/// - Preview's histogram is degenerate (>99% of pixels in one of 64 bins)
///
/// Callers fall back to AgX-Neutral on `None`.
pub fn fit_curve_from_raw<P: AsRef<Path>>(
    raw_path: P,
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    orientation: ExifOrientation,
) -> Option<ProfileCurve> {
    let path_ref = raw_path.as_ref();
    let preview = preview::extract_preview(path_ref)?;
    // Re-enable Adobe RGB detection. With the CS-aware harness, this
    // is the slightly-better path (test_0003 5.06 → 4.90). Detection
    // is pure-Rust via rawler.
    let cs = preview::detect_jpeg_color_space(path_ref);
    fit_curve_from_preview(preview, cs, source_rgb, source_w, source_h, orientation)
}

/// Bytes-based mirror of [`fit_curve_from_raw`] for the WASM render
/// entry. Uses [`preview::extract_preview_from_bytes`] (no exiftool
/// fallback) plus [`preview::detect_jpeg_color_space_from_bytes`].
///
/// `ext` is the file extension (e.g. `"dng"`) used as a rawler format
/// hint — see [`preview::extract_preview_from_bytes`] doc.
pub fn fit_curve_from_bytes(
    raw_bytes: &[u8],
    ext: &str,
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    orientation: ExifOrientation,
) -> Option<ProfileCurve> {
    let preview = preview::extract_preview_from_bytes(raw_bytes, ext)?;
    let cs = preview::detect_jpeg_color_space_from_bytes(raw_bytes, ext);
    fit_curve_from_preview(preview, cs, source_rgb, source_w, source_h, orientation)
}

fn fit_curve_from_preview(
    preview: DynamicImage,
    cs: JpegColorSpace,
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    _orientation: ExifOrientation,
) -> Option<ProfileCurve> {
    let preview_rgb = preview.to_rgb8();
    let target_w_px = preview_rgb.width() as usize;
    let target_h_px = preview_rgb.height() as usize;
    if target_w_px < 256 || target_h_px < 256 {
        return None;
    }

    // Keep both source and target in sensor frame — embedded JPEGs are
    // stored sensor-aligned on all 14 fixtures verified, and pairing for
    // the matrix LSQ requires same coordinate system. The orientation
    // parameter is retained for API stability but unused now.
    let target_rec2020 = jpeg_to_linear_rec2020(&preview_rgb, cs);

    if is_degenerate_histogram(&target_rec2020) {
        return None;
    }

    let target_aspect = target_w_px as f64 / target_h_px as f64;
    let source_aspect = source_w as f64 / source_h as f64;

    let (crop_x_start, crop_x_end, crop_y_start, crop_y_end) =
        if (source_aspect - target_aspect).abs() < 0.01 {
            (0, source_w, 0, source_h)
        } else if source_aspect > target_aspect {
            // Source is wider than target — crop left/right edges
            let new_w = (source_h as f64 * target_aspect).round() as usize;
            let crop_x = (source_w - new_w) / 2;
            (crop_x, crop_x + new_w, 0, source_h)
        } else {
            // Source is taller than target — crop top/bottom edges
            let new_h = (source_w as f64 / target_aspect).round() as usize;
            let crop_y = (source_h - new_h) / 2;
            (0, source_w, crop_y, crop_y + new_h)
        };

    let crop_w = crop_x_end - crop_x_start;
    let crop_h = crop_y_end - crop_y_start;
    let n_pixels = crop_w * crop_h;

    // Per-channel CDF matching on raw scene-linear Rec.2020.
    //
    // Each channel fits its own monotone curve from the source channel's
    // distribution to the embedded JPEG's same-channel distribution.
    // Channel ratios shift to match target distributions, partially
    // absorbing camera grading (sat_ratio 0.497 → 0.636 on test_0003);
    // the cross-channel matrix below closes the rest.
    let mut tgt_r = Vec::with_capacity(target_rec2020.len() / 3);
    let mut tgt_g = Vec::with_capacity(target_rec2020.len() / 3);
    let mut tgt_b = Vec::with_capacity(target_rec2020.len() / 3);
    for c in target_rec2020.chunks_exact(3) {
        tgt_r.push(c[0]);
        tgt_g.push(c[1]);
        tgt_b.push(c[2]);
    }

    // Source values pass through soft-knee compression (compress_input) before
    // CDF binning. HDR scene-linear values above 1.0 used to all clamp
    // into the top CDF bin (`build_cdf` clips to [0, 1]) and the fitted
    // curve produced a flat highlight tail. Compression maps `[0, +∞)`
    // monotonically into `[0, 1)` so every distinct bright value keeps
    // its own bin. `apply_curve` mirrors the same compression per-pixel
    // before evaluating the curve so input domain matches.
    let mut src_r = Vec::with_capacity(n_pixels);
    let mut src_g = Vec::with_capacity(n_pixels);
    let mut src_b = Vec::with_capacity(n_pixels);
    for y in crop_y_start..crop_y_end {
        let row_off = y * source_w;
        for x in crop_x_start..crop_x_end {
            let idx = (row_off + x) * 3;
            src_r.push(compress_input(source_rgb[idx]));
            src_g.push(compress_input(source_rgb[idx + 1]));
            src_b.push(compress_input(source_rgb[idx + 2]));
        }
    }

    // Curve fit: blend per-channel CDF curves with a single luminance
    // CDF curve. α=1 → pure per-channel (max grading freedom, prone
    // to overfit; visible contrast amplification because each channel's
    // CDF is steeper than the JPEG's actual tone curve). α=0 → pure
    // luminance (very gentle — earlier test of α=0 measured test_0006
    // +3.5 dE and test_0015 +6.3 dE because per-channel grading carries
    // genuine color information lost at α=0).
    //
    // α=0.2 measured as the best trade across 14 fixtures (mean dE 4.89
    // vs JPEG, down from 5.13 at α=0.85; 8 wins, 5 losses ≤ +0.61, 1
    // neutral; biggest wins test_0013 −1.35, test_0009 −1.17, test_0003
    // −1.12; biggest loss test_0015 +0.61). The per-channel curves still
    // contribute 20% — keeps the channel-specific color shaping that
    // pure luminance loses, while letting the smoother luminance curve
    // own most of the tone, which reads as less contrasty side-by-side
    // with the embedded JPEG.
    const BLEND_ALPHA: f32 = 0.2;
    let src_lum: Vec<f32> = src_r
        .iter()
        .zip(src_g.iter())
        .zip(src_b.iter())
        .map(|((&r, &g), &b)| 0.2126 * r + 0.7152 * g + 0.0722 * b)
        .collect();
    let tgt_lum: Vec<f32> = tgt_r
        .iter()
        .zip(tgt_g.iter())
        .zip(tgt_b.iter())
        .map(|((&r, &g), &b)| 0.2126 * r + 0.7152 * g + 0.0722 * b)
        .collect();
    let lum_curve = curve::fit_channel_curve(&src_lum, &tgt_lum);
    let pc_r = curve::fit_channel_curve(&src_r, &tgt_r);
    let pc_g = curve::fit_channel_curve(&src_g, &tgt_g);
    let pc_b = curve::fit_channel_curve(&src_b, &tgt_b);
    let blend = |pc: &curve::ChannelCurve, lum: &curve::ChannelCurve| {
        let mut anchors = [(0.0_f32, 0.0_f32); 32];
        for i in 0..32 {
            anchors[i].0 = pc.anchors[i].0;
            anchors[i].1 = BLEND_ALPHA * pc.anchors[i].1
                + (1.0 - BLEND_ALPHA) * lum.anchors[i].1;
        }
        // Re-enforce monotone after blend.
        for i in 1..32 {
            if anchors[i].1 < anchors[i - 1].1 {
                anchors[i].1 = anchors[i - 1].1;
            }
        }
        curve::ChannelCurve { anchors }
    };
    let r_curve = blend(&pc_r, &lum_curve);
    let g_curve = blend(&pc_g, &lum_curve);
    let b_curve = blend(&pc_b, &lum_curve);

    // Section 4: cross-channel correction matrix.
    //
    // Build paired samples by box-averaging both source crop and target
    // onto a common low-resolution grid. Per-pixel pairing is sensitive
    // to demosaic / sharpening differences and any sub-pixel registration
    // drift between Maple's render and the camera's preview pipeline;
    // tiny offsets propagate into noisy A/B rows and LSQ over-fits the
    // noise into chunky off-diagonals. Region averages erase the noise.
    //
    // Split pairs 80/20 into train/validate (every 5th cell to validate).
    // Fit the matrix on train. Apply only if validation residual drops
    // at least 15% vs identity (see gate below) — catches overfit cases
    // where matrix fits training pairs well but degrades on a held-out
    // region (measured: test_0009 / test_0010 over-saturated when the
    // matrix was applied unconditionally).
    //
    // Curves are applied to the source AFTER averaging — averaging is
    // (approximately) linear and the curve is non-linear, but pre-curve
    // averaging is the cheaper of the two equivalent setups since
    // `eval_channel` runs once per grid cell instead of once per source
    // pixel.
    const GRID: usize = 128;
    let mut a_train: Vec<[f32; 3]> = Vec::with_capacity(GRID * GRID * 4 / 5);
    let mut b_train: Vec<[f32; 3]> = Vec::with_capacity(GRID * GRID * 4 / 5);
    let mut a_val: Vec<[f32; 3]> = Vec::with_capacity(GRID * GRID / 5);
    let mut b_val: Vec<[f32; 3]> = Vec::with_capacity(GRID * GRID / 5);
    for gy in 0..GRID {
        for gx in 0..GRID {
            // Source cell: average a tile in the source crop.
            let sx0 = crop_x_start + (gx * crop_w) / GRID;
            let sx1 = crop_x_start + ((gx + 1) * crop_w) / GRID;
            let sy0 = crop_y_start + (gy * crop_h) / GRID;
            let sy1 = crop_y_start + ((gy + 1) * crop_h) / GRID;
            let mut sr = 0.0_f32;
            let mut sg = 0.0_f32;
            let mut sb = 0.0_f32;
            let mut sn = 0_u32;
            for y in sy0..sy1 {
                let row = y * source_w;
                for x in sx0..sx1 {
                    let idx = (row + x) * 3;
                    sr += source_rgb[idx];
                    sg += source_rgb[idx + 1];
                    sb += source_rgb[idx + 2];
                    sn += 1;
                }
            }
            if sn == 0 {
                continue;
            }
            let inv_sn = 1.0 / sn as f32;
            let sr = sr * inv_sn;
            let sg = sg * inv_sn;
            let sb = sb * inv_sn;

            // Target cell: same proportional position in the target
            // (which is sensor-frame, possibly different resolution).
            let tx0 = (gx * target_w_px) / GRID;
            let tx1 = ((gx + 1) * target_w_px) / GRID;
            let ty0 = (gy * target_h_px) / GRID;
            let ty1 = ((gy + 1) * target_h_px) / GRID;
            let mut tr = 0.0_f32;
            let mut tg = 0.0_f32;
            let mut tb = 0.0_f32;
            let mut tn = 0_u32;
            for y in ty0..ty1 {
                let row = y * target_w_px;
                for x in tx0..tx1 {
                    let idx = (row + x) * 3;
                    tr += target_rec2020[idx];
                    tg += target_rec2020[idx + 1];
                    tb += target_rec2020[idx + 2];
                    tn += 1;
                }
            }
            if tn == 0 {
                continue;
            }
            let inv_tn = 1.0 / tn as f32;
            let tr = tr * inv_tn;
            let tg = tg * inv_tn;
            let tb = tb * inv_tn;

            // Apply per-channel curves to the soft-knee-compressed
            // source-cell average after white balance normalization.
            let cr = curve::eval_channel(&r_curve, compress_input(sr));
            let cg = curve::eval_channel(&g_curve, compress_input(sg));
            let cb = curve::eval_channel(&b_curve, compress_input(sb));
            let a = [cr, cg, cb];
            let b = [tr, tg, tb];
            if (gy * GRID + gx) % 5 == 0 {
                a_val.push(a);
                b_val.push(b);
            } else {
                a_train.push(a);
                b_train.push(b);
            }
        }
    }
    let candidate = solve_3x3_lsq(&a_train, &b_train);

    // Validation gate: only adopt the candidate matrix if it cuts
    // the held-out residual by at least 15% vs identity. Catches
    // overfits where LSQ chases training noise into wide-swinging
    // off-diagonals that don't generalize.
    let res_identity: f32 = a_val
        .iter()
        .zip(b_val.iter())
        .map(|(a, b)| {
            (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)
        })
        .sum();
    let res_candidate: f32 = a_val
        .iter()
        .zip(b_val.iter())
        .map(|(a, b)| {
            let m = &candidate;
            let r = m[0][0] * a[0] + m[0][1] * a[1] + m[0][2] * a[2] - b[0];
            let g = m[1][0] * a[0] + m[1][1] * a[1] + m[1][2] * a[2] - b[1];
            let bl = m[2][0] * a[0] + m[2][1] * a[1] + m[2][2] * a[2] - b[2];
            r * r + g * g + bl * bl
        })
        .sum();
    // Adopt the matrix only if it cuts held-out residual by ≥15%.
    // Measured: at 5% gate the matrix slipped through and over-fit
    // test_0008/0009/0010; at 15% gate it's only adopted on fixtures
    // where per-channel-curve residual on validation pairs is genuinely
    // higher than matrix-applied residual. With the α=0.2 curve blend
    // upstream (lower than α=0.85 because the luminance curve carries
    // more of the tone now), fewer fixtures need the matrix at all —
    // it's rejected for every fixture in the current 14-fixture suite,
    // but kept wired for fixtures where it would help.
    let matrix = if res_candidate < 0.85 * res_identity {
        candidate
    } else {
        IDENTITY_MATRIX
    };

    // Fit a per-image chroma boost. After curves + matrix, Maple's
    // output chroma can still trail the JPEG (per-channel CDF match
    // is shape-preserving in chroma, not magnitude-amplifying). Measure
    // mean Oklab chroma of (curve+matrix-corrected) source vs target
    // on the same paired cells and apply the ratio in apply_curve.
    //
    // Bounds: clamp the boost into [0.7, 1.5] to prevent
    // pathological estimates from monochrome/saturated fixtures
    // pushing the whole image into nonsense chroma. The validation
    // is implicit — the chroma_mean is averaged over the full grid,
    // so outliers wash out.
    let mut cand_chroma_sum = 0.0_f64;
    let mut tgt_chroma_sum = 0.0_f64;
    let mut cand_a_sum = 0.0_f64;
    let mut cand_b_sum = 0.0_f64;
    let mut tgt_a_sum = 0.0_f64;
    let mut tgt_b_sum = 0.0_f64;
    let mut cand_l_sum = 0.0_f64;
    let mut tgt_l_sum = 0.0_f64;
    let mut n_cells = 0_u64;
    // 5-band L bias accumulators (anchor L = 0.0, 0.25, 0.5, 0.75, 1.0).
    // Each cell contributes to the band whose anchor is nearest to its
    // target L; per-band offset = mean(target_L - cand_L) within band.
    let mut band_l_diff_sum = [0.0_f64; 5];
    let mut band_l_count = [0_u64; 5];
    // Per-band a*/b*: track BOTH cand and target means separately so we
    // can solve for band_offset that zeroes the band's post-chain residual,
    // including the chroma_boost scaling that gets applied to cand at
    // render time.
    let mut band_cand_a_sum = [0.0_f64; 5];
    let mut band_cand_b_sum = [0.0_f64; 5];
    let mut band_tgt_a_sum = [0.0_f64; 5];
    let mut band_tgt_b_sum = [0.0_f64; 5];
    let m_arr = &matrix;
    let m_is_id = m_arr == &IDENTITY_MATRIX;
    for (a, b) in a_train.iter().chain(a_val.iter())
        .zip(b_train.iter().chain(b_val.iter()))
    {
        let (cr, cg, cb) = if m_is_id {
            (a[0], a[1], a[2])
        } else {
            (
                m_arr[0][0] * a[0] + m_arr[0][1] * a[1] + m_arr[0][2] * a[2],
                m_arr[1][0] * a[0] + m_arr[1][1] * a[1] + m_arr[1][2] * a[2],
                m_arr[2][0] * a[0] + m_arr[2][1] * a[1] + m_arr[2][2] * a[2],
            )
        };
        let cand_lab = crate::color::oklab::rec2020_to_oklab([cr, cg, cb]);
        let tgt_lab = crate::color::oklab::rec2020_to_oklab([b[0], b[1], b[2]]);
        cand_l_sum += cand_lab[0] as f64;
        tgt_l_sum += tgt_lab[0] as f64;
        // Bin by Rec.709 luma on the (display-linear Rec.2020) target —
        // matches what the per-band hue analyzer uses, so fit-time bins
        // align with measurement bins. Oklab L binning was misaligned
        // (Oklab L = 0.79 for mid-gray, Rec.709 luma = 0.5 for same).
        // Approximate Rec.709 weights on Rec.2020 RGB (close enough for
        // binning; the actual Rec.2020 luma weights are slightly different
        // but the bin assignment is robust to this).
        let tgt_y = 0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2];
        let bin_f = (tgt_y.clamp(0.0, 1.0) * 4.0).round() as usize;
        let bin_i = bin_f.min(4);
        band_l_diff_sum[bin_i] += (tgt_lab[0] - cand_lab[0]) as f64;
        band_l_count[bin_i] += 1;
        band_cand_a_sum[bin_i] += cand_lab[1] as f64;
        band_cand_b_sum[bin_i] += cand_lab[2] as f64;
        band_tgt_a_sum[bin_i] += tgt_lab[1] as f64;
        band_tgt_b_sum[bin_i] += tgt_lab[2] as f64;
        cand_a_sum += cand_lab[1] as f64;
        cand_b_sum += cand_lab[2] as f64;
        tgt_a_sum += tgt_lab[1] as f64;
        tgt_b_sum += tgt_lab[2] as f64;
        let cand_c = (cand_lab[1].powi(2) + cand_lab[2].powi(2)).sqrt();
        let tgt_c = (tgt_lab[1].powi(2) + tgt_lab[2].powi(2)).sqrt();
        cand_chroma_sum += cand_c as f64;
        tgt_chroma_sum += tgt_c as f64;
        n_cells += 1;
    }
    let chroma_boost = if n_cells > 0 && cand_chroma_sum > 1e-4 {
        (tgt_chroma_sum / cand_chroma_sum) as f32
    } else {
        1.0
    }.clamp(0.7, 1.5);

    // a/b offset measured in Oklab space. Note: Oklab a/b are
    // dimensionless in [~-0.4, +0.4] for typical colors; the 0.05
    // clamp here is large enough to correct severe casts (test_0010
    // measured −6.7 Lab units = ~0.03 Oklab units) but small enough
    // that fixed pathological estimates won't push pixels into wild
    // hues. Compute the offset AFTER chroma_boost is applied so the
    // residual to correct is the true post-boost shift.
    let inv_n = if n_cells > 0 { 1.0 / n_cells as f64 } else { 0.0 };
    let cand_a_mean = (cand_a_sum * inv_n) as f32;
    let cand_b_mean = (cand_b_sum * inv_n) as f32;
    let tgt_a_mean = (tgt_a_sum * inv_n) as f32;
    let tgt_b_mean = (tgt_b_sum * inv_n) as f32;
    // After chroma_boost scales a/b by chroma_boost, the post-boost
    // mean is cand_a_mean * chroma_boost. The offset needed is the
    // gap between that and the target mean.
    let post_boost_a = cand_a_mean * chroma_boost;
    let post_boost_b = cand_b_mean * chroma_boost;
    let offset_a = (tgt_a_mean - post_boost_a).clamp(-0.05, 0.05);
    let offset_b = (tgt_b_mean - post_boost_b).clamp(-0.05, 0.05);
    let chroma_offset = [offset_a, offset_b];

    // Lightness offset: mean L gap between corrected source and
    // target, applied in Oklab L space. Closes uniform brightness
    // bias that per-channel curves leave (test_0009 had +2.3 CIELab
    // L bias across all bands). Bounded to ±0.03 Oklab L to prevent
    // pathological pushes.
    let cand_l_mean = (cand_l_sum * inv_n) as f32;
    let tgt_l_mean = (tgt_l_sum * inv_n) as f32;
    let lightness_offset = (tgt_l_mean - cand_l_mean).clamp(-0.03, 0.03);

    // Per-band L offsets (5 anchors at L=0/0.25/0.5/0.75/1.0). Each is
    // the residual L bias in that band MINUS the global lightness_offset
    // (which is already applied uniformly) — so the band LUT carries
    // only the deviation-from-global shape (CONTRAST_LOW shows up as
    // negative band offsets in shadows + positive in highlights, etc).
    // Bounded ±0.02 per anchor: smaller than the global because bands
    // have fewer samples and bigger swings risk overfitting.
    let mut band_offsets = [0.0_f32; 5];
    let mut ab_band = [[0.0_f32; 2]; 5];
    for i in 0..5 {
        if band_l_count[i] > 50 {
            let count = band_l_count[i] as f64;
            let band_l = (band_l_diff_sum[i] / count) as f32;
            // Per-band L cap at ±0.02 Oklab (~2 CIELab L). Tighter than
            // the global lightness_offset cap (±0.03) because per-band
            // fits draw on fewer samples and overshoot more easily.
            // Earlier sweep tested ±0.04 (loosened to give shadow-heavy
            // fixtures like test_0005 more headroom), then ±0.015 and
            // ±0.005 — ±0.02 was the best trade vs the residual the
            // global offset already absorbs.
            band_offsets[i] = (band_l - lightness_offset).clamp(-0.02, 0.02);
            // a*/b* band offsets need to ZERO the post-chain residual:
            //   apply chain: cand_ab * chroma_boost + chroma_offset + band_corr
            //   want this to equal target_ab on average per band.
            //   band_corr = mean(target_ab) - chroma_boost * mean(cand_ab) - chroma_offset
            // Skipping the boost term gave near-zero offsets when boost ≠ 1
            // (test_0003 boost ≈ 1.5 → mean(target − cand) is already close
            // to chroma_offset, so band_corr ≈ 0).
            let cand_a = band_cand_a_sum[i] / count;
            let cand_b = band_cand_b_sum[i] / count;
            let tgt_a = band_tgt_a_sum[i] / count;
            let tgt_b = band_tgt_b_sum[i] / count;
            let needed_a = tgt_a - chroma_boost as f64 * cand_a - chroma_offset[0] as f64;
            let needed_b = tgt_b - chroma_boost as f64 * cand_b - chroma_offset[1] as f64;
            ab_band[i][0] = (needed_a as f32).clamp(-0.06, 0.06);
            ab_band[i][1] = (needed_b as f32).clamp(-0.06, 0.06);
        }
    }

    Some(ProfileCurve {
        r: r_curve,
        g: g_curve,
        b: b_curve,
        matrix,
        chroma_boost,
        chroma_offset,
        lightness_offset,
        lightness_band_offsets: band_offsets,
        ab_band_offsets: ab_band,
    })
}

fn jpeg_to_linear_rec2020(jpeg: &image::RgbImage, cs: JpegColorSpace) -> Vec<f32> {
    // sRGB linear → Rec.2020 (D65). Standard matrix.
    const SRGB_TO_REC2020: [[f32; 3]; 3] = [
        [0.6274039, 0.3292830, 0.0433131],
        [0.0690973, 0.9195404, 0.0113623],
        [0.0163914, 0.0880133, 0.8955953],
    ];

    // Adobe RGB linear → Rec.2020 (D65). Derived as
    // M_XYZ→Rec2020 · M_AdobeRGB→XYZ (Bruce Lindbloom matrices, D65).
    const ADOBE_TO_REC2020: [[f32; 3]; 3] = [
        [0.8774, 0.0775, 0.0452],
        [0.0966, 0.8912, 0.0118],
        [0.0229, 0.0430, 0.9338],
    ];

    let (matrix, decode): (&[[f32; 3]; 3], fn(f32) -> f32) = match cs {
        JpegColorSpace::SRgb => (&SRGB_TO_REC2020, srgb_decode),
        JpegColorSpace::AdobeRgb => (&ADOBE_TO_REC2020, adobe_decode),
    };

    let raw = jpeg.as_raw();
    let mut out = Vec::with_capacity(raw.len());
    for chunk in raw.chunks_exact(3) {
        let r_lin = decode(chunk[0] as f32 / 255.0);
        let g_lin = decode(chunk[1] as f32 / 255.0);
        let b_lin = decode(chunk[2] as f32 / 255.0);

        let r = matrix[0][0] * r_lin + matrix[0][1] * g_lin + matrix[0][2] * b_lin;
        let g = matrix[1][0] * r_lin + matrix[1][1] * g_lin + matrix[1][2] * b_lin;
        let b = matrix[2][0] * r_lin + matrix[2][1] * g_lin + matrix[2][2] * b_lin;

        out.push(r);
        out.push(g);
        out.push(b);
    }
    out
}

/// Inverse Adobe RGB (1998) EOTF — pure power 2.2 per channel.
/// Spec: IEC 61966-2-5; gamma = 563/256 ≈ 2.199.
#[inline]
fn adobe_decode(v: f32) -> f32 {
    v.max(0.0).powf(2.19921875)
}

/// Inverse sRGB EOTF — display-encoded sRGB to linear-light. IEC 61966-2-1.
///
/// A private mirror of `color::hsm::srgb_to_linear_one` to keep the
/// `auto_profile` module independent of color-module internals. Identical
/// math — the duplication is intentional until a shared crate-level helper
/// is introduced.
#[inline]
fn srgb_decode(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Reject preview JPEGs whose linear-Rec.2020 distribution is concentrated
/// in a single 64-bin bucket (>99% of pixels). Such images carry no useful
/// per-channel curve signal — pure-black, pure-white, or near-uniform
/// previews.
fn is_degenerate_histogram(rgb: &[f32]) -> bool {
    if rgb.is_empty() {
        return true;
    }
    let n = rgb.len();
    let mut hist = [0_u32; 64];
    for v in rgb {
        let idx = (v.clamp(0.0, 1.0) * 63.0) as usize;
        hist[idx.min(63)] += 1;
    }
    let max_count = *hist.iter().max().unwrap();
    max_count as f32 / n as f32 > 0.99
}

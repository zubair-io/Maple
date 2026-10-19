//! Native-pixel design matrices for the JPEG-band minimax fit.
use super::{ANCHORS, LUMA_BANDS, MIN_BAND_PIXELS};

/// Footprint size of every JPEG pixel: the count of full-res source pixels
/// that the box downscale maps into it. Uses the SAME integer span mapping as
/// the gate's reference resample (`(o·crop)/out` .. `((o+1)·crop)/out`, each
/// span at least 1px). Indexed `[oy*out_w + ox]`.
pub(in super::super) fn footprint_sizes(
    crop_w: usize,
    crop_h: usize,
    out_w: usize,
    out_h: usize,
) -> Vec<u32> {
    let mut row_w = vec![0u32; out_w];
    for (ox, w) in row_w.iter_mut().enumerate() {
        let x0 = (ox * crop_w) / out_w;
        let mut x1 = ((ox + 1) * crop_w) / out_w;
        if x1 <= x0 {
            x1 = x0 + 1;
        }
        *w = (x1 - x0) as u32;
    }
    let mut out = vec![0u32; out_w * out_h];
    for oy in 0..out_h {
        let y0 = (oy * crop_h) / out_h;
        let mut y1 = ((oy + 1) * crop_h) / out_h;
        if y1 <= y0 {
            y1 = y0 + 1;
        }
        let rows = (y1 - y0) as u32;
        let base = oy * out_w;
        for ox in 0..out_w {
            out[base + ox] = rows * row_w[ox];
        }
    }
    out
}

/// Build the EXACT eval-then-box per-channel design matrices `M[lane][b][a]`,
/// where the band mean of the rendered candidate equals `Σ_a M[b][a]·out[a]`.
///
/// One pass over the full-res source crop: each source pixel `p` is mapped to
/// the JPEG pixel `j` it downscales into (same integer span mapping the gate's
/// reference resample uses), weighted by `1/|F_j|` so every JPEG pixel
/// contributes total weight 1 (footprint-size-independent — the equal-per-
/// JPEG-pixel weighting the gate applies). Its channel value selects an anchor
/// bracket `(lo, frac)`; `eval = out[lo]·(1−frac) + out[lo+1]·frac`, so the
/// pixel adds `(1/|F_j|)(1−frac)` to `M[band(j)][lo]` and `(1/|F_j|)frac` to
/// `M[band(j)][lo+1]`. Finally each band row is divided by `N_b` (the JPEG-
/// pixel count in band `b`) to form the per-band MEAN operator.
#[allow(clippy::too_many_arguments)]
pub(in super::super) fn build_design_matrices(
    src: &[f32],
    src_stride_px: usize,
    crop_x0: usize,
    crop_y0: usize,
    crop_w: usize,
    crop_h: usize,
    out_w: usize,
    out_h: usize,
    band_of: &[usize],
    band_counts: &[usize; LUMA_BANDS.len()],
    footprint: &[u32],
) -> [[[f32; ANCHORS]; LUMA_BANDS.len()]; 3] {
    build_design_matrices_mapped(
        src,
        src_stride_px,
        crop_x0,
        crop_y0,
        crop_w,
        crop_h,
        out_w,
        out_h,
        band_of,
        band_counts,
        footprint,
        |v| v,
    )
}

/// Fit the post-transform residual without allocating a second native RGB frame.
#[allow(clippy::too_many_arguments)]
pub(in super::super) fn build_design_matrices_mapped(
    src: &[f32],
    src_stride_px: usize,
    crop_x0: usize,
    crop_y0: usize,
    crop_w: usize,
    crop_h: usize,
    out_w: usize,
    out_h: usize,
    band_of: &[usize],
    band_counts: &[usize; LUMA_BANDS.len()],
    footprint: &[u32],
    transform: impl Fn([f32; 3]) -> [f32; 3],
) -> [[[f32; ANCHORS]; LUMA_BANDS.len()]; 3] {
    let nb = LUMA_BANDS.len();
    let mut m = [[[0.0f64; ANCHORS]; LUMA_BANDS.len()]; 3];

    // Iterate OUTPUT (JPEG) pixels and GATHER each one's source span — the same
    // structure the gate's resample uses. This composes correctly for BOTH
    // directions: on downscale a JPEG pixel gathers many source pixels; on
    // UPSCALE (e.g. test_0010: render 5040×3360 < JPEG 6720×4480) the span is a
    // single source pixel (footprint == 1 = nearest, matching Pillow BOX on
    // upscale). A source-iterating scatter would leave upscale JPEG pixels
    // empty, collapsing each band row sum to the source/JPEG area ratio.
    for oy in 0..out_h {
        let sy0 = (oy * crop_h) / out_h;
        let mut sy1 = ((oy + 1) * crop_h) / out_h;
        if sy1 <= sy0 {
            sy1 = sy0 + 1;
        }
        let jrow = oy * out_w;
        for ox in 0..out_w {
            let j = jrow + ox;
            let b = band_of[j];
            if b == usize::MAX {
                continue;
            }
            let fp = footprint[j];
            if fp == 0 {
                continue;
            }
            let inv_fp = 1.0 / fp as f64;
            let sx0 = (ox * crop_w) / out_w;
            let mut sx1 = ((ox + 1) * crop_w) / out_w;
            if sx1 <= sx0 {
                sx1 = sx0 + 1;
            }
            for sy in sy0..sy1 {
                let srow = (crop_y0 + sy) * src_stride_px + crop_x0;
                for sx in sx0..sx1 {
                    let idx = (srow + sx) * 3;
                    let pixel = transform([src[idx], src[idx + 1], src[idx + 2]]);
                    for lane in 0..3 {
                        let v = pixel[lane].clamp(0.0, 1.0);
                        let scaled = v * (ANCHORS - 1) as f32;
                        let lo = (scaled.floor() as usize).min(ANCHORS - 2);
                        let frac = (scaled - lo as f32) as f64;
                        m[lane][b][lo] += inv_fp * (1.0 - frac);
                        m[lane][b][lo + 1] += inv_fp * frac;
                    }
                }
            }
        }
    }

    // Divide each band row by the JPEG-pixel count → per-band MEAN operator.
    let mut out = [[[0.0f32; ANCHORS]; LUMA_BANDS.len()]; 3];
    for lane in 0..3 {
        for b in 0..nb {
            let nbj = band_counts[b];
            if nbj == 0 {
                continue;
            }
            let inv = 1.0 / nbj as f64;
            for a in 0..ANCHORS {
                out[lane][b][a] = (m[lane][b][a] * inv) as f32;
            }
        }
    }
    out
}

/// Per-band, per-channel mean of the JPEG target. `band_target[lane][b]` is the
/// gate's target `T_{b}` for that channel. Bands below `MIN_BAND_PIXELS` carry
/// `NaN` (no target) — the solver leaves their anchors free.
pub(in super::super) fn band_targets(
    target: &[f32],
    band_of: &[usize],
    band_counts: &[usize; LUMA_BANDS.len()],
) -> [[f32; LUMA_BANDS.len()]; 3] {
    let nb = LUMA_BANDS.len();
    let mut sum = [[0.0f64; LUMA_BANDS.len()]; 3];
    for (j, &b) in band_of.iter().enumerate() {
        if b == usize::MAX {
            continue;
        }
        for lane in 0..3 {
            sum[lane][b] += target[j * 3 + lane] as f64;
        }
    }
    let mut out = [[f32::NAN; LUMA_BANDS.len()]; 3];
    for lane in 0..3 {
        for b in 0..nb {
            if band_counts[b] >= MIN_BAND_PIXELS {
                out[lane][b] = (sum[lane][b] / band_counts[b] as f64) as f32;
            }
        }
    }
    out
}

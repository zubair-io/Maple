//! ALIKED input preparation — pure functions, no ONNX Runtime involved.
//!
//! The pinned ALIKED export (see `maple-pano/models.toml`) takes a single
//! static input `image` of shape `[1, 3, S, S]`, f32 RGB in `[0, 1]`,
//! produced by **letterboxing**: the source is resized to fit inside the
//! `S × S` square preserving aspect ratio, anchored at the top-left, and
//! the remainder is zero-padded. This mirrors the export's reference
//! runtime (ikeboo/ALIKED-LightGlue-ONNX `preprocess`/`padding`), which is
//! the ground truth for how these graphs were validated.
//!
//! # Transfer encode (linear → sRGB)
//!
//! The crate's frames are **scene-linear** ([`crate::source`] linearity
//! contract). ALIKED was trained on display-encoded photographs (its
//! reference runtimes feed 8-bit JPEG/PNG bytes divided by 255), so
//! feeding linear values would systematically darken mid-tones and starve
//! the detector of the contrast distribution it was trained on. The
//! preprocessor therefore applies the sRGB OETF ([`srgb_oetf`]) and — like
//! the 8-bit reference path, which resizes already-encoded bytes —
//! resamples **in encoded space**.
//!
//! # Coordinate model (binding for keypoint mapping)
//!
//! Three coordinate systems appear, all per-axis:
//!
//! 1. **Source continuous pixels** — the crate convention: texel `(ix,
//!    iy)` centered at `(ix + 0.5, iy + 0.5)` ([`crate::camera`] docs).
//! 2. **Inference index pixels** — the resized image inside the `S × S`
//!    square, integer-grid convention (texel centers at integers): this is
//!    what ALIKED's DKD emits sub-pixel keypoints in.
//! 3. **Normalized inference coordinates** — ALIKED normalizes keypoints
//!    as `n = idx / (S − 1) * 2 − 1` (soft_detect.py: `wh = (w−1, h−1)`,
//!    `kpts / wh * 2 − 1`), i.e. `[-1, 1]` maps to index `0 ‥ S−1`.
//!
//! The resampler uses center-aligned mapping (`src_cont = dst_cont ·
//! src_dim / dst_dim`, the cv2.resize/INTER_LINEAR convention), so the
//! exact inverse for a keypoint is:
//!
//! ```text
//! idx        = (n + 1) / 2 · (S − 1)          // normalized → index
//! infer_cont = idx + 0.5                      // index → continuous
//! src_cont   = infer_cont · src_dim / resized_dim
//! ```
//!
//! Note the deliberate divergence from the reference runtime's
//! `(n + 1) / 2 · max(w, h)` shortcut, which conflates `S` with `S − 1`
//! and drops the half-texel center shift — up to ~1.5 px of systematic
//! bias that a bundle adjuster would happily "solve" into the cameras.
//! The unit tests pin the exact chain both directions.

use super::LinearRgbFrame;

/// sRGB opto-electronic transfer function (IEC 61966-2-1), the standard
/// piecewise encode. Input is clamped to `[0, 1]` first — scene-linear
/// values above 1.0 carry no extra information for the detector.
pub fn srgb_oetf(linear: f32) -> f32 {
    let v = linear.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// Geometry of one letterbox placement: everything needed to map between
/// source pixels and the model's normalized keypoint coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Letterbox {
    /// Model input side length `S` (the static square).
    pub target: u32,
    /// Source frame size.
    pub src_w: u32,
    pub src_h: u32,
    /// Resized image size inside the square (`≤ target`, aspect kept,
    /// floor-rounded exactly like the reference runtime).
    pub resized_w: u32,
    pub resized_h: u32,
}

impl Letterbox {
    /// Compute the letterbox placement of a `src_w × src_h` frame into a
    /// `target × target` input. The scale is `min(target/h, target/w)` and
    /// the resized dimensions floor like the reference's `int(h · scale)`
    /// — but evaluated in exact integer arithmetic (`dim · target /
    /// max_dim`), so the long axis is always exactly `target` and there is
    /// no `1279.999… → 1279` float hazard. Short axis is clamped to at
    /// least 1 texel for degenerate aspect ratios.
    pub fn layout(src_w: u32, src_h: u32, target: u32) -> Self {
        debug_assert!(src_w > 0 && src_h > 0 && target > 0);
        let long = u64::from(src_w.max(src_h));
        let scale_floor =
            |dim: u32| -> u32 { ((u64::from(dim) * u64::from(target) / long) as u32).max(1) };
        let (resized_w, resized_h) = (scale_floor(src_w), scale_floor(src_h));
        Self {
            target,
            src_w,
            src_h,
            resized_w,
            resized_h,
        }
    }

    /// Map an ALIKED normalized keypoint to **source continuous pixel**
    /// coordinates (the crate convention). See the module docs for the
    /// derivation of each step.
    pub fn norm_to_src_px(&self, nx: f32, ny: f32) -> (f32, f32) {
        let s1 = (self.target - 1) as f64;
        let idx_x = (nx as f64 + 1.0) * 0.5 * s1;
        let idx_y = (ny as f64 + 1.0) * 0.5 * s1;
        let src_x = (idx_x + 0.5) * self.src_w as f64 / self.resized_w as f64;
        let src_y = (idx_y + 0.5) * self.src_h as f64 / self.resized_h as f64;
        (src_x as f32, src_y as f32)
    }

    /// Inverse of [`Self::norm_to_src_px`]: source continuous pixel →
    /// normalized inference coordinates. Used by tests to pin the round
    /// trip and available to later stages that need to seed the matcher
    /// with prior positions.
    pub fn src_px_to_norm(&self, sx: f32, sy: f32) -> (f32, f32) {
        let s1 = (self.target - 1) as f64;
        let infer_x = sx as f64 * self.resized_w as f64 / self.src_w as f64;
        let infer_y = sy as f64 * self.resized_h as f64 / self.src_h as f64;
        let nx = (infer_x - 0.5) / s1 * 2.0 - 1.0;
        let ny = (infer_y - 0.5) / s1 * 2.0 - 1.0;
        (nx as f32, ny as f32)
    }
}

/// Letterbox a scene-linear frame into the model's `[1, 3, S, S]` CHW
/// tensor data: sRGB-encode, bilinear-resample in encoded space
/// (center-aligned taps, edge clamp), zero-pad the remainder, planar
/// `R G B` plane order. Returns the placement geometry and the
/// `3 · S · S` tensor buffer.
pub fn letterbox_to_chw(frame: &LinearRgbFrame, target: u32) -> (Letterbox, Vec<f32>) {
    let lb = Letterbox::layout(frame.width, frame.height, target);
    let s = target as usize;
    let (src_w, src_h) = (frame.width as usize, frame.height as usize);
    let (dst_w, dst_h) = (lb.resized_w as usize, lb.resized_h as usize);

    // Encoded copy of the source (resampling happens in encoded space —
    // module docs). Sized for the milestone's inputs: detection runs on
    // render frames / downsampled proxies, not full-resolution RAWs (the
    // eng-design memory plan keeps full-res pixels out of the feature
    // stage).
    let encoded: Vec<f32> = frame.pixels.iter().map(|&v| srgb_oetf(v)).collect();

    let mut chw = vec![0.0_f32; 3 * s * s];
    let x_ratio = src_w as f64 / dst_w as f64;
    let y_ratio = src_h as f64 / dst_h as f64;
    for dy in 0..dst_h {
        // Center-aligned source coordinate, then bilinear taps with edge
        // clamp (cv2.resize INTER_LINEAR semantics).
        let sy = (dy as f64 + 0.5) * y_ratio - 0.5;
        let y0 = sy.floor();
        let fy = (sy - y0) as f32;
        let iy0 = (y0 as i64).clamp(0, src_h as i64 - 1) as usize;
        let iy1 = (y0 as i64 + 1).clamp(0, src_h as i64 - 1) as usize;
        for dx in 0..dst_w {
            let sx = (dx as f64 + 0.5) * x_ratio - 0.5;
            let x0 = sx.floor();
            let fx = (sx - x0) as f32;
            let ix0 = (x0 as i64).clamp(0, src_w as i64 - 1) as usize;
            let ix1 = (x0 as i64 + 1).clamp(0, src_w as i64 - 1) as usize;
            let (p00, p01) = ((iy0 * src_w + ix0) * 3, (iy0 * src_w + ix1) * 3);
            let (p10, p11) = ((iy1 * src_w + ix0) * 3, (iy1 * src_w + ix1) * 3);
            for c in 0..3 {
                let top = encoded[p00 + c] * (1.0 - fx) + encoded[p01 + c] * fx;
                let bot = encoded[p10 + c] * (1.0 - fx) + encoded[p11 + c] * fx;
                chw[c * s * s + dy * s + dx] = top * (1.0 - fy) + bot * fy;
            }
        }
    }
    (lb, chw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_oetf_matches_standard_anchor_points() {
        assert_eq!(srgb_oetf(0.0), 0.0);
        assert!((srgb_oetf(1.0) - 1.0).abs() < 1e-6);
        // Linear-segment boundary: 12.92 · 0.0031308 = 0.04045…
        assert!((srgb_oetf(0.003_130_8) - 0.040_449).abs() < 1e-5);
        // 18% grey encodes to ≈ 0.4613.
        assert!((srgb_oetf(0.18) - 0.461_356).abs() < 1e-4);
        // Clamps out-of-range scene values.
        assert_eq!(srgb_oetf(-0.5), 0.0);
        assert!((srgb_oetf(7.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn layout_downscale_matches_reference_arithmetic() {
        // 4000×3000 into 1280: scale = 0.32 → 1280×960.
        let lb = Letterbox::layout(4000, 3000, 1280);
        assert_eq!((lb.resized_w, lb.resized_h), (1280, 960));
        // 4001×3000 into 1280: scale = 1280/4001 → 3000·s = 959.76… and
        // the reference's int() truncation keeps 959, not a round() 960.
        let lb = Letterbox::layout(4001, 3000, 1280);
        assert_eq!((lb.resized_w, lb.resized_h), (1280, 959));
    }

    #[test]
    fn layout_upscales_small_sources_like_the_reference() {
        // min(1280/80, 1280/100) = 12.8 → 1280×1024.
        let lb = Letterbox::layout(100, 80, 1280);
        assert_eq!((lb.resized_w, lb.resized_h), (1280, 1024));
    }

    #[test]
    fn norm_to_src_round_trips_with_src_to_norm() {
        for &(w, h) in &[(4000_u32, 3000_u32), (1280, 960), (333, 777), (50, 40)] {
            let lb = Letterbox::layout(w, h, 1280);
            for &(sx, sy) in &[(0.5_f32, 0.5_f32), (10.25, 20.75), (250.0, 30.5)] {
                let (nx, ny) = lb.src_px_to_norm(sx, sy);
                let (bx, by) = lb.norm_to_src_px(nx, ny);
                assert!(
                    (bx - sx).abs() < 1e-3 && (by - sy).abs() < 1e-3,
                    "{w}x{h}: ({sx},{sy}) → ({nx},{ny}) → ({bx},{by})"
                );
            }
        }
    }

    /// Pin the absolute mapping, not just the round trip: with a source
    /// that needs no resize (src = S × S), normalized −1 is index 0 =
    /// continuous 0.5, and normalized +1 is index S−1 = continuous S−0.5.
    #[test]
    fn norm_mapping_absolute_anchors_at_identity_scale() {
        let s = 1280;
        let lb = Letterbox::layout(s, s, s);
        assert_eq!((lb.resized_w, lb.resized_h), (s, s));
        let (x, y) = lb.norm_to_src_px(-1.0, -1.0);
        assert!((x - 0.5).abs() < 1e-4 && (y - 0.5).abs() < 1e-4);
        let (x, y) = lb.norm_to_src_px(1.0, 1.0);
        assert!((x - (s as f32 - 0.5)).abs() < 1e-3, "got {x}");
        assert!((y - (s as f32 - 0.5)).abs() < 1e-3, "got {y}");
        // Center of the normalized range = center texel boundary.
        let (x, _) = lb.norm_to_src_px(0.0, 0.0);
        assert!((x - ((s as f32 - 1.0) * 0.5 + 0.5)).abs() < 1e-3);
    }

    /// The downscale mapping must account for the floor-rounded resized
    /// dimensions per axis (this is where the reference's max(w,h)
    /// shortcut drifts).
    #[test]
    fn norm_mapping_uses_per_axis_resized_ratios() {
        let lb = Letterbox::layout(4000, 3000, 1280);
        // Normalized −1 → index 0 → continuous 0.5 → source 0.5 · 4000/1280.
        let (x, y) = lb.norm_to_src_px(-1.0, -1.0);
        assert!((x - 0.5 * 4000.0 / 1280.0).abs() < 1e-3, "got {x}");
        assert!((y - 0.5 * 3000.0 / 960.0).abs() < 1e-3, "got {y}");
    }

    #[test]
    fn letterbox_to_chw_is_planar_with_zero_padding() {
        // 2×1 source, distinct channels; target 4 → resized 4×2.
        let frame = LinearRgbFrame::new(2, 1, vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]).expect("frame");
        let (lb, chw) = letterbox_to_chw(&frame, 4);
        assert_eq!((lb.resized_w, lb.resized_h), (4, 2));
        assert_eq!(chw.len(), 3 * 4 * 4);
        let plane = 16;
        // Rows 2..4 of every plane are padding.
        for c in 0..3 {
            for i in 8..16 {
                assert_eq!(chw[c * plane + i], 0.0, "padding plane {c} idx {i}");
            }
        }
        // Left edge of row 0 is pure (encoded) red: R≈1, G≈0.
        assert!((chw[0] - 1.0).abs() < 1e-5, "R at (0,0) = {}", chw[0]);
        assert_eq!(chw[plane], 0.0, "G at (0,0)");
        // Right edge is pure green.
        assert_eq!(chw[3], 0.0, "R at (3,0)");
        assert!((chw[plane + 3] - 1.0).abs() < 1e-5, "G at (3,0)");
        // Blue plane is empty everywhere.
        for i in 0..8 {
            assert_eq!(chw[2 * plane + i], 0.0, "B idx {i}");
        }
    }

    /// A constant linear image must produce exactly `srgb_oetf(v)` at
    /// every valid sample — resampling in encoded space cannot invent
    /// values — and zeros in the padding.
    #[test]
    fn letterbox_to_chw_constant_image_encodes_uniformly() {
        let frame = LinearRgbFrame::new(10, 6, vec![0.18; 10 * 6 * 3]).expect("frame");
        let (lb, chw) = letterbox_to_chw(&frame, 8);
        assert_eq!((lb.resized_w, lb.resized_h), (8, 4));
        let want = srgb_oetf(0.18);
        let s = 8;
        for c in 0..3 {
            for y in 0..s {
                for x in 0..s {
                    let v = chw[c * s * s + y * s + x];
                    if y < 4 {
                        assert!((v - want).abs() < 1e-6, "({x},{y}) plane {c}: {v}");
                    } else {
                        assert_eq!(v, 0.0, "({x},{y}) plane {c} must be padding");
                    }
                }
            }
        }
    }

    /// Identity-scale letterbox (src already S × S) must reproduce the
    /// encoded source exactly: center-aligned taps degenerate to a copy.
    #[test]
    fn letterbox_identity_scale_is_exact_copy() {
        let mut pixels = Vec::with_capacity(4 * 4 * 3);
        for i in 0..(4 * 4 * 3) {
            pixels.push((i as f32) / 47.0);
        }
        let frame = LinearRgbFrame::new(4, 4, pixels.clone()).expect("frame");
        let (_, chw) = letterbox_to_chw(&frame, 4);
        for y in 0..4 {
            for x in 0..4 {
                for c in 0..3 {
                    let want = srgb_oetf(pixels[(y * 4 + x) * 3 + c]);
                    let got = chw[c * 16 + y * 4 + x];
                    assert!((got - want).abs() < 1e-6, "({x},{y},{c}): {got} vs {want}");
                }
            }
        }
    }
}

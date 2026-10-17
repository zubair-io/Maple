//! Decode-tier LCP correction uses the DNG opcode gather/sampling sink.
//! Illumination is corrected in recorded coordinates before geometric gather.

use super::model::{Calibration, Vignette};
use crate::{
    pipeline::pano::{opcode_apply::LensCorrectionScales, opcodes::ActiveAreaRect},
    Image,
};
use rayon::prelude::*;

pub fn apply(
    image: &mut Image,
    calibration: &Calibration,
    area: ActiveAreaRect,
    scales: LensCorrectionScales,
) -> Result<(), String> {
    let full_dims = (image.width, image.height);
    apply_windowed(image, calibration, area, scales, (0, 0), full_dims)
}

pub fn apply_windowed(
    image: &mut Image,
    calibration: &Calibration,
    area: ActiveAreaRect,
    scales: LensCorrectionScales,
    origin: (u32, u32),
    full_dims: (u32, u32),
) -> Result<(), String> {
    if area.width == 0
        || area.height == 0
        || area
            .left
            .checked_add(area.width)
            .is_none_or(|x| x > full_dims.0)
        || area
            .top
            .checked_add(area.height)
            .is_none_or(|y| y > full_dims.1)
    {
        return Err("LCP calibration rectangle is outside the decoded image".into());
    }
    let (width, height) = (area.width as f64, area.height as f64);
    let warp = (scales.distortion > 0.0 && calibration.distortion.is_some())
        || (scales.ca > 0.0 && calibration.ca.is_some());
    // Validate before mutation. A malformed profile never leaves a partly
    // corrected buffer or turns a failed gain into a silent no-op.
    if let Some(vignette) = calibration.vignette.filter(|_| scales.vignetting > 0.0) {
        validate_vignette(vignette, width, height)?;
    }
    if warp {
        for y in [0.0, height * 0.5, height] {
            for x in [0.0, width * 0.5, width] {
                for channel in 0..3 {
                    if source(calibration, scales, width, height, [x, y], channel)
                        .iter()
                        .any(|v| !v.is_finite())
                    {
                        return Err("LCP warp is not finite over the calibration rectangle".into());
                    }
                }
            }
        }
    }
    let stride = image.width as usize;
    let tile_h = image.height as usize;
    let (ox, oy) = (origin.0 as usize, origin.1 as usize);
    let (aa_top, aa_left, aa_w, aa_h) = (
        area.top as usize,
        area.left as usize,
        area.width as usize,
        area.height as usize,
    );
    let row_start = aa_top.saturating_sub(oy).min(tile_h);
    let row_end = (aa_top + aa_h).saturating_sub(oy).min(tile_h);
    let col_start = aa_left.saturating_sub(ox).min(stride);
    let col_end = (aa_left + aa_w).saturating_sub(ox).min(stride);
    if row_start >= row_end || col_start >= col_end {
        return Ok(());
    }
    if let Some(vignette) = calibration.vignette.filter(|_| scales.vignetting > 0.0) {
        image
            .pixels
            .par_chunks_mut(stride)
            .skip(row_start)
            .take(row_end - row_start)
            .enumerate()
            .for_each(|(i, row)| {
                let y = (oy + row_start + i) - aa_top;
                for col in col_start..col_end {
                    let x = (ox + col) - aa_left;
                    let gain = vignette
                        .gain(width, height, [x as f64, y as f64])
                        .expect("validated positive illumination");
                    let blended = (1.0 + scales.vignetting as f64 * (gain - 1.0)) as f32;
                    for value in &mut row[col] {
                        *value *= blended;
                    }
                }
            });
    }
    if !warp {
        return Ok(());
    }
    let input = image.pixels.clone();
    let common = calibration.ca.is_none() || scales.ca == 0.0;
    let bounds = WindowBounds {
        stride,
        aa: (aa_top, aa_left, aa_w, aa_h),
        origin: (ox, oy),
        cols: (col_start, col_end),
        rows: (row_start, row_end),
    };
    image
        .pixels
        .par_chunks_mut(stride)
        .skip(row_start)
        .take(row_end - row_start)
        .enumerate()
        .for_each(|(i, row)| {
            let y = (oy + row_start + i) - aa_top;
            for col in col_start..col_end {
                let x = (ox + col) - aa_left;
                let point = [x as f64, y as f64];
                if common {
                    let [sx, sy] = source(calibration, scales, width, height, point, 1);
                    row[col] = sample_windowed(&input, &bounds, sx, sy);
                } else {
                    for channel in 0..3 {
                        let [sx, sy] = source(calibration, scales, width, height, point, channel);
                        row[col][channel] = sample_windowed_ch(&input, &bounds, sx, sy, channel);
                    }
                }
            }
        });
    Ok(())
}

/// Conservative upper bound on source-pixel displacement across `area` for the
/// active distortion and lateral CA warp, plus the bilinear stencil margin (#4729).
pub fn reach_px(
    calibration: &Calibration,
    area: ActiveAreaRect,
    scales: LensCorrectionScales,
) -> usize {
    let warp = (scales.distortion > 0.0 && calibration.distortion.is_some())
        || (scales.ca > 0.0 && calibration.ca.is_some());
    if !warp || area.width == 0 || area.height == 0 {
        return 0;
    }
    let max_extent = area.width.max(area.height) as usize;
    let (width, height) = (area.width as f64, area.height as f64);
    let mut rect = [0.0, width, 0.0, height];
    let mut bound = [0.0_f64; 2];
    if scales.distortion > 0.0 {
        if let Some(d) = calibration.distortion {
            let Some([dx, dy]) = model_disp_bound(d.frame, d, rect, width, height) else {
                return max_extent;
            };
            let s = scales.distortion as f64;
            bound = [s * dx, s * dy];
            rect = [-bound[0], width + bound[0], -bound[1], height + bound[1]];
        }
    }
    if scales.ca > 0.0 {
        if let Some(ca) = calibration.ca {
            let mut ca_bound = [0.0_f64; 2];
            for rel in ca.relative {
                let Some([dx, dy]) = model_disp_bound(ca.reference, rel, rect, width, height)
                else {
                    return max_extent;
                };
                ca_bound = [ca_bound[0].max(dx), ca_bound[1].max(dy)];
            }
            let s = scales.ca as f64;
            bound = [bound[0] + s * ca_bound[0], bound[1] + s * ca_bound[1]];
        }
    }
    let peak = bound[0].max(bound[1]);
    if !peak.is_finite() {
        return max_extent;
    }
    (peak.ceil() as usize).saturating_add(2).min(max_extent)
}

/// Upper-bounds `|p.frame.pixels(p.normalized(ref_frame.coordinates(pt))) - pt|`
/// over `pt in [rect[0], rect[1]] x [rect[2], rect[3]]` by scanning the 1D radial
/// polynomial on `[0, r_max]` with a Mean-Value-Theorem Lipschitz remainder and
/// adding the analytical tangential and principal-point bounds.
fn model_disp_bound(
    ref_frame: super::model::Frame,
    p: super::model::Perspective,
    rect: [f64; 4],
    width: f64,
    height: f64,
) -> Option<[f64; 2]> {
    let d_max = width.max(height);
    let [x0, y0] = ref_frame.coordinates(width, height, [rect[0], rect[2]]);
    let [x1, y1] = ref_frame.coordinates(width, height, [rect[1], rect[3]]);
    let (x_max, y_max) = (x0.abs().max(x1.abs()), y0.abs().max(y1.abs()));
    let r_max = x_max.hypot(y_max);
    if !r_max.is_finite() {
        return None;
    }
    let [k1, k2, k3] = p.radial;
    let [c1, c3] = p.radial_odd;
    let [p1, p2] = p.tangential;
    let r2 = r_max * r_max;
    let poly_lip = 2.0 * c1.abs() * r_max
        + 3.0 * k1.abs() * r2
        + 4.0 * c3.abs() * r2 * r_max
        + 5.0 * k2.abs() * r2 * r2
        + 7.0 * k3.abs() * r2 * r2 * r2;
    let tang = [
        2.0 * p1.abs() * x_max * y_max + p2.abs() * (3.0 * x_max * x_max + y_max * y_max),
        p1.abs() * (x_max * x_max + 3.0 * y_max * y_max) + 2.0 * p2.abs() * x_max * y_max,
    ];
    let dims = [width, height];
    const STEPS: usize = 256;
    let mut out = [0.0_f64; 2];
    for a in 0..2 {
        let (alpha, beta) = (p.scale * p.frame.focal[a], ref_frame.focal[a]);
        let mut max_g = 0.0_f64;
        for i in 0..=STEPS {
            let r = r_max * (i as f64 / STEPS as f64);
            let r_sq = r * r;
            let radial = 1.0 + r_sq * (k1 + r_sq * (k2 + r_sq * k3)) + r * (c1 + r_sq * c3);
            max_g = max_g.max((r * (alpha * radial - beta)).abs());
        }
        let mvt = (r_max / (2.0 * STEPS as f64)) * ((alpha - beta).abs() + alpha.abs() * poly_lip);
        let shift = ((p.frame.center[a] - ref_frame.center[a]) * dims[a]).abs();
        let bound = d_max * (max_g + mvt + alpha.abs() * tang[a]) + shift;
        if !bound.is_finite() {
            return None;
        }
        out[a] = bound;
    }
    Some(out)
}

struct WindowBounds {
    stride: usize,
    aa: (usize, usize, usize, usize),
    origin: (usize, usize),
    cols: (usize, usize),
    rows: (usize, usize),
}

#[inline]
fn sample_coords(b: &WindowBounds, x: f64, y: f64) -> (usize, usize, usize, usize, f32, f32) {
    let (aa_top, aa_left, aa_w, aa_h) = b.aa;
    let (x, y) = (
        x.clamp(0.0, (aa_w - 1) as f64),
        y.clamp(0.0, (aa_h - 1) as f64),
    );
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(aa_w - 1), (y0 + 1).min(aa_h - 1));
    let (fx, fy) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
    let col = |xx: usize| {
        ((aa_left + xx) as isize - b.origin.0 as isize)
            .clamp(b.cols.0 as isize, (b.cols.1 - 1) as isize) as usize
    };
    let row = |yy: usize| {
        ((aa_top + yy) as isize - b.origin.1 as isize)
            .clamp(b.rows.0 as isize, (b.rows.1 - 1) as isize) as usize
    };
    (col(x0), col(x1), row(y0), row(y1), fx, fy)
}

#[inline]
fn sample_windowed(src: &[[f32; 3]], b: &WindowBounds, x: f64, y: f64) -> [f32; 3] {
    let (c0, c1, r0, r1, fx, fy) = sample_coords(b, x, y);
    let (r0s, r1s) = (r0 * b.stride, r1 * b.stride);
    let (p00, p01, p10, p11) = (src[r0s + c0], src[r0s + c1], src[r1s + c0], src[r1s + c1]);
    std::array::from_fn(|c| {
        let top = p00[c] + (p01[c] - p00[c]) * fx;
        let bot = p10[c] + (p11[c] - p10[c]) * fx;
        top + (bot - top) * fy
    })
}

#[inline]
fn sample_windowed_ch(src: &[[f32; 3]], b: &WindowBounds, x: f64, y: f64, c: usize) -> f32 {
    let (c0, c1, r0, r1, fx, fy) = sample_coords(b, x, y);
    let top =
        src[r0 * b.stride + c0][c] + (src[r0 * b.stride + c1][c] - src[r0 * b.stride + c0][c]) * fx;
    let bot =
        src[r1 * b.stride + c0][c] + (src[r1 * b.stride + c1][c] - src[r1 * b.stride + c0][c]) * fx;
    top + (bot - top) * fy
}

fn source(
    calibration: &Calibration,
    scales: LensCorrectionScales,
    width: f64,
    height: f64,
    point: [f64; 2],
    channel: usize,
) -> [f64; 2] {
    let distorted = calibration
        .distortion
        .map(|m| m.map(width, height, point))
        .unwrap_or(point);
    let common: [f64; 2] =
        std::array::from_fn(|i| point[i] + scales.distortion as f64 * (distorted[i] - point[i]));
    let chromatic = calibration
        .ca
        .map(|m| m.map(width, height, common, channel))
        .unwrap_or(common);
    std::array::from_fn(|i| common[i] + scales.ca as f64 * (chromatic[i] - common[i]))
}

/// A cubic's extrema on [0,r²max] are its endpoints and real derivative
/// roots. Check them, not a sparse pixel grid that can miss a negative lobe.
fn validate_vignette(model: Vignette, width: f64, height: f64) -> Result<(), String> {
    let mut max_radius = 0.0_f64;
    for point in [[0.0, 0.0], [width, 0.0], [0.0, height], [width, height]] {
        let [x, y] = model.frame.coordinates(width, height, point);
        max_radius = max_radius.max(x * x + y * y);
    }
    let [a, b, c] = model.radial;
    let mut candidates = vec![0.0, max_radius];
    if c == 0.0 {
        if b != 0.0 {
            candidates.push(-a / (2.0 * b));
        }
    } else {
        let discriminant = 4.0 * b * b - 12.0 * c * a;
        if discriminant >= 0.0 {
            candidates.push((-2.0 * b + discriminant.sqrt()) / (6.0 * c));
            candidates.push((-2.0 * b - discriminant.sqrt()) / (6.0 * c));
        }
    }
    for r2 in candidates
        .into_iter()
        .filter(|r| *r >= 0.0 && *r <= max_radius)
    {
        let illumination = 1.0 + r2 * (a + r2 * (b + r2 * c));
        if !illumination.is_finite() || illumination <= 0.0 || 1.0 / illumination > f32::MAX as f64
        {
            return Err(
                "LCP illumination polynomial is not positive over the calibration rectangle".into(),
            );
        }
    }
    if !max_radius.is_finite() {
        return Err("LCP focal normalization overflow".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lens_profile::model::{Frame, Perspective};

    fn calibration() -> Calibration {
        Calibration {
            distortion: Some(Perspective {
                frame: Frame {
                    focal: [1.0; 2],
                    center: [0.5; 2],
                },
                radial: [0.2, 0.0, 0.0],
                radial_odd: [0.0; 2],
                tangential: [0.0; 2],
                scale: 1.0,
            }),
            ca: None,
            vignette: None,
            mean_error: 0.0,
        }
    }

    #[test]
    fn strengths_and_active_area_share_the_opcode_sampler() {
        let mut image = Image::new(8, 6, crate::image::ColorSpace::CameraNativeLinearRgb);
        for (i, pixel) in image.pixels.iter_mut().enumerate() {
            *pixel = [i as f32; 3];
        }
        let original = image.pixels.clone();
        let area = ActiveAreaRect {
            left: 1,
            top: 1,
            width: 6,
            height: 4,
        };
        apply(&mut image, &calibration(), area, LensCorrectionScales::NONE).unwrap();
        assert_eq!(image.pixels, original);
        apply(&mut image, &calibration(), area, LensCorrectionScales::FULL).unwrap();
        assert_ne!(image.pixels, original);
        assert_eq!(&image.pixels[..8], &original[..8]);
        assert_eq!(image.pixels[8], original[8]);
        assert_eq!(image.pixels[47], original[47]);
    }

    #[test]
    fn gain_preserves_scene_headroom_and_invalid_profile_does_not_mutate() {
        let mut image = Image::new(10, 10, crate::image::ColorSpace::CameraNativeLinearRgb);
        image.pixels.fill([4.0; 3]);
        let area = ActiveAreaRect::full(10, 10);
        let mut c = calibration();
        c.distortion = None;
        c.vignette = Some(Vignette {
            frame: Frame {
                focal: [1.0; 2],
                center: [0.5; 2],
            },
            radial: [-0.5, 0.0, 0.0],
        });
        apply(&mut image, &c, area, LensCorrectionScales::FULL).unwrap();
        assert!(image.pixels[0][0] > 4.0);
        let before = image.pixels.clone();
        c.vignette.as_mut().unwrap().radial[0] = -4.0;
        assert!(apply(&mut image, &c, area, LensCorrectionScales::FULL).is_err());
        assert_eq!(before, image.pixels);
    }

    #[test]
    fn windowed_apply_matches_full_frame_for_distortion_ca_and_vignette() {
        use crate::lens_profile::model::Chromatic;
        let frame = Frame {
            focal: [1.0; 2],
            center: [0.5; 2],
        };
        let lobe = |radial, scale| Perspective {
            frame,
            radial: [radial, 0.0, 0.0],
            radial_odd: [0.0; 2],
            tangential: [0.0; 2],
            scale,
        };
        let cal = Calibration {
            distortion: Some(Perspective {
                radial: [0.08, -0.02, 0.0],
                radial_odd: [0.01, 0.0],
                tangential: [0.005, -0.003],
                ..lobe(0.0, 1.0)
            }),
            ca: Some(Chromatic {
                reference: frame,
                relative: [lobe(0.01, 1.002), lobe(-0.01, 0.998)],
            }),
            vignette: Some(Vignette {
                frame,
                radial: [-0.35, 0.1, 0.0],
            }),
            mean_error: 0.0,
        };
        let (full_w, full_h) = (48u32, 40u32);
        let area = ActiveAreaRect {
            left: 2,
            top: 2,
            width: 44,
            height: 36,
        };
        let reach = reach_px(&cal, area, LensCorrectionScales::FULL);
        assert!(reach >= 3, "expected positive warp reach, got {reach}");
        let mut full = Image::new(
            full_w,
            full_h,
            crate::image::ColorSpace::CameraNativeLinearRgb,
        );
        for (i, px) in full.pixels.iter_mut().enumerate() {
            let (x, y) = ((i as u32 % full_w) as f32, (i as u32 / full_w) as f32);
            *px = [0.2 + x * 0.01, 0.3 + y * 0.015, 0.1 + (x + y) * 0.008];
        }
        let orig = full.clone();
        apply(&mut full, &cal, area, LensCorrectionScales::FULL).unwrap();
        let (ox, oy, tw, th) = (6u32, 5u32, 28u32, 24u32);
        let mut tile = Image::new(tw, th, crate::image::ColorSpace::CameraNativeLinearRgb);
        for y in 0..th {
            for x in 0..tw {
                tile.pixels[(y * tw + x) as usize] =
                    orig.pixels[((oy + y) * full_w + (ox + x)) as usize];
            }
        }
        apply_windowed(
            &mut tile,
            &cal,
            area,
            LensCorrectionScales::FULL,
            (ox, oy),
            (full_w, full_h),
        )
        .unwrap();
        let pad = reach as u32;
        for y in pad..(th - pad) {
            for x in pad..(tw - pad) {
                assert_eq!(
                    tile.pixels[(y * tw + x) as usize],
                    full.pixels[((oy + y) * full_w + (ox + x)) as usize]
                );
            }
        }
        let interior = Calibration {
            distortion: Some(Perspective {
                radial: [10.0, -20.0, 10.0],
                ..lobe(0.0, 1.0)
            }),
            ..calibration()
        };
        let rect = ActiveAreaRect::full(200, 200);
        let bound = reach_px(&interior, rect, LensCorrectionScales::FULL);
        let mut peak = 0.0_f64;
        for x in 0..200 {
            let [sx, _] = source(
                &interior,
                LensCorrectionScales::FULL,
                200.0,
                200.0,
                [x as f64, 100.0],
                1,
            );
            peak = peak.max((sx - x as f64).abs());
        }
        assert!(
            bound >= peak.ceil() as usize + 2,
            "bound {bound} < peak {peak} + 2"
        );
        let huge = Calibration {
            distortion: Some(lobe(1.0e30, 1.0)),
            ..calibration()
        };
        assert_eq!(reach_px(&huge, rect, LensCorrectionScales::FULL), 200);
    }
}

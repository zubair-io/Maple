//! Decode-tier LCP correction uses the DNG opcode gather/sampling sink.
//! Illumination is corrected in recorded coordinates before geometric gather.

use super::model::{Calibration, Vignette};
use crate::{
    pipeline::pano::{
        opcode_apply::{bilinear_aa, bilinear_aa_ch, LensCorrectionScales},
        opcodes::ActiveAreaRect,
    },
    Image,
};
use rayon::prelude::*;

pub fn apply(
    image: &mut Image,
    calibration: &Calibration,
    area: ActiveAreaRect,
    scales: LensCorrectionScales,
) -> Result<(), String> {
    if area.width == 0
        || area.height == 0
        || area
            .left
            .checked_add(area.width)
            .is_none_or(|x| x > image.width)
        || area
            .top
            .checked_add(area.height)
            .is_none_or(|y| y > image.height)
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
    if let Some(vignette) = calibration.vignette.filter(|_| scales.vignetting > 0.0) {
        image
            .pixels
            .par_chunks_mut(image.width as usize)
            .skip(area.top as usize)
            .take(area.height as usize)
            .enumerate()
            .for_each(|(y, row)| {
                for x in 0..area.width as usize {
                    let gain = vignette
                        .gain(width, height, [x as f64, y as f64])
                        .expect("validated positive illumination");
                    let blended = (1.0 + scales.vignetting as f64 * (gain - 1.0)) as f32;
                    for value in &mut row[area.left as usize + x] {
                        *value *= blended;
                    }
                }
            });
    }
    if !warp {
        return Ok(());
    }
    let input = image.pixels.clone();
    let stride = image.width as usize;
    let (top, left, w, h) = (
        area.top as usize,
        area.left as usize,
        area.width as usize,
        area.height as usize,
    );
    let common = calibration.ca.is_none() || scales.ca == 0.0;
    image
        .pixels
        .par_chunks_mut(stride)
        .skip(top)
        .take(h)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w {
                let point = [x as f64, y as f64];
                if common {
                    let [sx, sy] = source(calibration, scales, width, height, point, 1);
                    row[left + x] = bilinear_aa(&input, stride, top, left, w, h, sx, sy);
                } else {
                    for channel in 0..3 {
                        let [sx, sy] = source(calibration, scales, width, height, point, channel);
                        row[left + x][channel] =
                            bilinear_aa_ch(&input, stride, top, left, w, h, sx, sy, channel);
                    }
                }
            }
        });
    Ok(())
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
}

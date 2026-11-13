//! Native-footprint reduction for the existing half-resolution camera prefix
//! (#3955). Compose ordered edits on each native sample BEFORE averaging, so
//! disjoint pixels in one bin cannot attenuate each other's accepted coverage.
use super::{lerp3, sample_cov, sample_rgb, sampling_map};
use crate::{
    image::{ColorSpace, Image},
    math::Matrix3,
    types::InpaintPatch,
};

pub(crate) fn apply(
    img: &mut Image,
    patches: &[InpaintPatch],
    to_camera: Matrix3,
    window: [f32; 4],
) {
    img.assert_space(ColorSpace::CameraNativeLinearRgb);
    // Cold source/stack preparation only; no map allocation inside a pixel loop.
    let maps: Vec<_> = patches
        .iter()
        .map(|patch| {
            (
                patch,
                sampling_map([2 * img.width, 2 * img.height], patch, window),
            )
        })
        .collect();
    for y in 0..img.height {
        for x in 0..img.width {
            let index = (y * img.width + x) as usize;
            let mut native = [img.pixels[index]; 4];
            let mut changed = false;
            for (patch, [sx, sy, ox, oy]) in &maps {
                for dy in 0..2 {
                    let v = (2 * y + dy) as f32 * sy + oy;
                    if v < -0.5 || v >= patch.height as f32 - 0.5 {
                        continue;
                    }
                    for dx in 0..2 {
                        let u = (2 * x + dx) as f32 * sx + ox;
                        if u < -0.5 || u >= patch.width as f32 - 0.5 {
                            continue;
                        }
                        let coverage = sample_cov(&patch.coverage, patch.width, patch.height, u, v)
                            .clamp(0.0, 1.0);
                        if coverage == 0.0 {
                            continue;
                        }
                        let rgb = to_camera.mul_vec(sample_rgb(
                            &patch.pixels,
                            patch.width,
                            patch.height,
                            u,
                            v,
                        ));
                        let at = (dy * 2 + dx) as usize;
                        native[at] = lerp3(native[at], rgb, coverage);
                        changed = true;
                    }
                }
            }
            if changed {
                img.pixels[index] = std::array::from_fn(|c| {
                    native[0][c] * 0.25
                        + native[1][c] * 0.25
                        + native[2][c] * 0.25
                        + native[3][c] * 0.25
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transparent_rgb_cannot_contaminate_one_pixel_and_disjoint_edits_do_not_fade_each_other() {
        let mut image = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
        image.pixels.fill([0.2; 3]);
        let patch = |coverage| InpaintPatch {
            width: 2,
            height: 2,
            origin: [0.0; 2],
            extent: [1.0; 2],
            pixels: vec![[1.0; 3], [2.0; 3], [500.0; 3], [-500.0; 3]],
            coverage,
        };
        apply(
            &mut image,
            &[patch(vec![1.0, 0.0, 0.0, 0.0])],
            Matrix3::IDENTITY,
            [0.0, 0.0, 1.0, 1.0],
        );
        assert!(image.pixels[0].iter().all(|v| (*v - 0.4).abs() < 1e-6));
        image.pixels.fill([0.2; 3]);
        apply(
            &mut image,
            &[
                patch(vec![1.0, 0.0, 0.0, 0.0]),
                patch(vec![0.0, 1.0, 0.0, 0.0]),
            ],
            Matrix3::IDENTITY,
            [0.0, 0.0, 1.0, 1.0],
        );
        assert!(image.pixels[0].iter().all(|v| (*v - 0.85).abs() < 1e-6));
    }

    #[test]
    fn overlapping_edits_keep_order_and_uncovered_bins_are_bit_exact() {
        let mut image = Image::new(2, 1, ColorSpace::CameraNativeLinearRgb);
        image.pixels.fill([0.2; 3]);
        let patch = |rgb| InpaintPatch {
            width: 1,
            height: 1,
            origin: [0.0; 2],
            extent: [0.25, 0.5],
            pixels: vec![rgb],
            coverage: vec![1.0],
        };
        apply(
            &mut image,
            &[patch([1.0; 3]), patch([2.0; 3])],
            Matrix3::IDENTITY,
            [0.0, 0.0, 1.0, 1.0],
        );
        assert!(image.pixels[0].iter().all(|v| (*v - 0.65).abs() < 1e-6));
        assert_eq!(image.pixels[1], [0.2; 3]);
    }
}

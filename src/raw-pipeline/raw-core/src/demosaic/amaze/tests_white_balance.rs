use super::{amaze, amaze_camera};
use crate::demosaic::{demosaic_camera_cancellable, demosaic_cancellable, DemosaicAlgorithm};
use crate::image::{CfaPattern, ColorSpace, Image};
use crate::CancelToken;

const PATTERNS: [CfaPattern; 4] = [
    CfaPattern::Rggb,
    CfaPattern::Bggr,
    CfaPattern::Grbg,
    CfaPattern::Gbrg,
];

fn mosaic(w: u32, h: u32, cfa: CfaPattern, neutral: [f32; 3], scene: usize) -> Image {
    let mut image = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            image.pixels[(y * w + x) as usize][c] = truth(x, y, scene)[c] * neutral[c];
        }
    }
    image
}

fn truth(x: u32, y: u32, scene: usize) -> [f32; 3] {
    let width = if scene == 0 { 4.0 } else { 0.6 };
    let edge = 1.0 / (1.0 + (-(x as f32 + 0.73 * y as f32 - 82.4) / width).exp());
    match scene {
        2 => [0.4 + 0.18 * (x as f32 * 1.1).sin() + 0.15 * (y as f32 * 0.7).cos(); 3],
        3 => [0.04 + 0.71 * edge, 0.15, 0.75 - 0.71 * edge],
        _ => [0.04 + 0.71 * edge; 3],
    }
}

fn reconstruction_error(image: &Image, neutral: [f32; 3], scene: usize) -> f64 {
    let mut sum = 0.0;
    for y in 16..image.height - 16 {
        for x in 16..image.width - 16 {
            let expected = truth(x, y, scene);
            let actual = image.pixels[(y * image.width + x) as usize];
            for c in 0..3 {
                sum += (actual[c] / neutral[c] - expected[c]).abs() as f64;
            }
        }
    }
    sum
}

#[test]
fn balancing_reduces_reconstruction_error_on_analytic_scenes() {
    // Neutral ramps, edges, texture, and a real red/blue boundary, for every
    // Bayer phase and several camera responses. Compare against known scene
    // values after undoing the camera response, not another demosaic kernel.
    for cfa in PATTERNS {
        for neutral in [[0.37, 1.0, 0.68], [1.0, 0.5, 0.2], [0.7, 1.0, 0.25]] {
            for scene in 0..4 {
                let input = mosaic(96, 96, cfa, neutral, scene);
                let old = reconstruction_error(&amaze(&input, cfa), neutral, scene);
                let new = reconstruction_error(&amaze_camera(&input, cfa, neutral), neutral, scene);
                assert!(
                    new < old,
                    "{cfa:?} {neutral:?} scene {scene}: {new} >= {old}"
                );
            }
        }
    }
}

#[test]
fn balancing_preserves_samples_and_camera_domain_across_tiles() {
    for cfa in PATTERNS {
        // Also exercise a gain convention with max(AsShotNeutral) != 1.
        for neutral in [[0.37, 1.0, 0.68], [2.0, 1.0, 0.4]] {
            let input = mosaic(301, 259, cfa, neutral, 2);
            let saved = input.pixels.clone();
            let output = amaze_camera(&input, cfa, neutral);
            assert_eq!(
                (output.width, output.height, output.space),
                (301, 259, ColorSpace::CameraNativeLinearRgb)
            );
            assert_eq!(input.pixels, saved);
            for (i, pixel) in output.pixels.iter().enumerate() {
                let c = cfa.color_at((i % 301) as u32, (i / 301) as u32) as usize;
                assert_eq!(pixel[c].to_bits(), input.pixels[i][c].to_bits());
                assert!(pixel.iter().all(|v| v.is_finite()));
            }
            assert_eq!(output.pixels, amaze_camera(&input, cfa, neutral).pixels);
        }
    }
}

#[test]
fn invalid_or_identity_neutral_retains_unbalanced_fallback() {
    let input = mosaic(48, 48, CfaPattern::Rggb, [0.4, 1.0, 0.6], 2);
    let expected = amaze(&input, CfaPattern::Rggb);
    for neutral in [
        [1.0; 3],
        [0.0, 1.0, 0.6],
        [-0.4, 1.0, 0.6],
        [f32::NAN, 1.0, 0.6],
        [0.4, f32::INFINITY, 0.6],
    ] {
        assert_eq!(
            amaze_camera(&input, CfaPattern::Rggb, neutral).pixels,
            expected.pixels
        );
    }
}

#[test]
fn balancing_retains_scene_values_above_one() {
    for cfa in PATTERNS {
        let neutral = [0.4, 1.0, 0.6];
        let expected = neutral.map(|n| 8.0 * n);
        let mut input = Image::new(32, 32, ColorSpace::CameraNativeMosaic);
        for (i, pixel) in input.pixels.iter_mut().enumerate() {
            let c = cfa.color_at((i % 32) as u32, (i / 32) as u32) as usize;
            pixel[c] = expected[c];
        }
        let output = amaze_camera(&input, cfa, neutral);
        for pixel in output.pixels {
            for c in 0..3 {
                assert!((pixel[c] - expected[c]).abs() < 1e-5, "{cfa:?}: {pixel:?}");
            }
        }
    }
}

#[test]
fn tiny_frames_keep_the_original_fallback() {
    for cfa in PATTERNS {
        for (w, h) in [(0, 0), (2, 2), (8, 8), (16, 32), (32, 16)] {
            let input = mosaic(w, h, cfa, [0.4, 1.0, 0.6], 0);
            assert_eq!(
                amaze_camera(&input, cfa, [0.4, 1.0, 0.6]).pixels,
                amaze(&input, cfa).pixels
            );
        }
    }
}

#[test]
fn camera_dispatch_changes_only_amaze_kernels() {
    let cfa = CfaPattern::Rggb;
    let neutral = [0.4, 1.0, 0.6];
    let input = mosaic(48, 48, cfa, neutral, 2);
    let cancel = CancelToken::never();
    for algo in [
        DemosaicAlgorithm::Bilinear,
        DemosaicAlgorithm::HamiltonAdams,
        DemosaicAlgorithm::Rcd,
        DemosaicAlgorithm::Vng4,
        DemosaicAlgorithm::Lmmse,
        DemosaicAlgorithm::DualRcdVng4,
        DemosaicAlgorithm::HalfRes,
    ] {
        assert_eq!(
            demosaic_camera_cancellable(algo, &input, cfa, neutral, cancel).pixels,
            demosaic_cancellable(algo, &input, cfa, cancel).pixels,
            "{algo:?}"
        );
    }
    assert_eq!(
        demosaic_camera_cancellable(DemosaicAlgorithm::Amaze, &input, cfa, neutral, cancel).pixels,
        amaze_camera(&input, cfa, neutral).pixels
    );
    // A cancelled dual blend leaves the detailed output for the caller's
    // existing post-demosaic cancellation check to discard.
    let flag = std::sync::atomic::AtomicBool::new(true);
    assert_eq!(
        demosaic_camera_cancellable(
            DemosaicAlgorithm::DualAmazeVng4,
            &input,
            cfa,
            neutral,
            CancelToken::new(&flag)
        )
        .pixels,
        amaze_camera(&input, cfa, neutral).pixels
    );
}

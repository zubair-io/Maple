//! Input-domain invariants for metadata-derived AMaZE preconditioning.
use super::{amaze, amaze_with_gains};
use crate::image::{CfaPattern, ColorSpace, Image};

fn mosaic(pattern: CfaPattern, neutral: [f32; 3], clipped_glint: bool) -> Image {
    let mut m = Image::new(96, 96, ColorSpace::CameraNativeMosaic);
    for y in 0..96 {
        for x in 0..96 {
            let dx = x as f32 - 47.3;
            let dy = y as f32 - 48.7;
            let scene = if clipped_glint {
                0.02 + 12.0 * (-(dx * dx + dy * dy) / (2.0 * 2.0_f32.powi(2))).exp()
            } else {
                0.2
            };
            let c = pattern.color_at(x, y) as usize;
            m.pixels[(y * 96 + x) as usize][c] = (scene * neutral[c]).min(1.0);
        }
    }
    m
}

#[test]
fn unity_gains_are_the_original_entry_point() {
    let m = mosaic(CfaPattern::Rggb, [0.37, 1.0, 0.67], true);
    assert_eq!(
        amaze(&m, CfaPattern::Rggb).pixels,
        amaze_with_gains(&m, CfaPattern::Rggb, [1.0; 3]).pixels
    );
}

#[test]
fn balanced_reconstruction_returns_native_flat_field_in_all_bayer_phases() {
    let n = [0.37, 1.0, 0.67];
    let scales = n.map(|v| 0.37 / v);
    for cfa in [
        CfaPattern::Rggb,
        CfaPattern::Bggr,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
    ] {
        let out = amaze_with_gains(&mosaic(cfa, n, false), cfa, scales);
        for y in 24..72 {
            for x in 24..72 {
                for (c, neutral) in n.into_iter().enumerate() {
                    assert!((out.pixels[y * 96 + x][c] - 0.2 * neutral).abs() < 2e-6);
                }
            }
        }
    }
}

#[test]
fn preconditioning_preserves_sensor_samples_through_clipped_glints() {
    let n = [0.37, 1.0, 0.67];
    let scales = n.map(|v| 0.37 / v);
    for cfa in [
        CfaPattern::Rggb,
        CfaPattern::Bggr,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
    ] {
        let input = mosaic(cfa, n, true);
        let out = amaze_with_gains(&input, cfa, scales);
        for y in 0..96 {
            for x in 0..96 {
                let c = cfa.color_at(x, y) as usize;
                let i = (y * 96 + x) as usize;
                assert_eq!(input.pixels[i][c].to_bits(), out.pixels[i][c].to_bits());
                assert!(out.pixels[i].iter().all(|v| v.is_finite()));
            }
        }
    }
}

#[test]
fn invalid_metadata_preserves_original_camera_dispatch() {
    use crate::{
        cancel::CancelToken,
        demosaic::{camera_demosaic_cancellable, DemosaicAlgorithm},
    };
    let cfa = CfaPattern::Rggb;
    let m = mosaic(cfa, [0.37, 1.0, 0.67], true);
    let expected = amaze(&m, cfa);
    for neutral in [
        [0.0, 1.0, 0.67],
        [-0.37, 1.0, 0.67],
        [f32::NAN, 1.0, 0.67],
        [f32::INFINITY, 1.0, 0.67],
        [f32::MIN_POSITIVE, f32::MAX, 1.0],
    ] {
        let actual = camera_demosaic_cancellable(
            DemosaicAlgorithm::Amaze,
            &m,
            cfa,
            neutral,
            None,
            CancelToken::never(),
        );
        assert_eq!(actual.pixels, expected.pixels);
    }
}

#[test]
fn other_kernels_keep_the_native_domain_contract() {
    use crate::{
        cancel::CancelToken,
        demosaic::{camera_demosaic_cancellable, demosaic, DemosaicAlgorithm},
    };
    let cfa = CfaPattern::Rggb;
    let neutral = [0.37, 1.0, 0.67];
    let m = mosaic(cfa, neutral, true);
    for algorithm in [
        DemosaicAlgorithm::Bilinear,
        DemosaicAlgorithm::HamiltonAdams,
        DemosaicAlgorithm::Rcd,
        DemosaicAlgorithm::HalfRes,
    ] {
        let expected = demosaic(algorithm, &m, cfa);
        let actual =
            camera_demosaic_cancellable(algorithm, &m, cfa, neutral, None, CancelToken::never());
        assert_eq!(actual.pixels, expected.pixels);
    }
}

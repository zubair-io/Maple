//! Gain-map saturation ceilings follow the actual CA sample operator (#4647).
use super::*;
use crate::linearize::{
    gain_map_tests::{calibrated_raw, list, payload},
    sensor_gains::SensorGains,
    GainMaps,
};

fn spatial_raw(w: u32, h: u32, cfa: CfaPattern) -> crate::image::RawImage {
    let mut raw = calibrated_raw(w, h);
    raw.cfa = cfa;
    raw.crop_rect = None;
    raw.lens_metadata.active_area = None;
    let ops: Vec<_> = (0..4)
        .map(|i| {
            (
                9,
                0,
                payload(
                    [i / 2, i % 2, h as i32, w as i32],
                    [2; 2],
                    [2; 2],
                    [1.; 2],
                    [0.; 2],
                    &[1. + i as f32 * 0.1, 2.3, 3.1, 4.],
                ),
            )
        })
        .collect();
    raw.sensor_gain_maps = GainMaps::parse(&list(&ops)).unwrap();
    raw
}

#[test]
fn gain_ceilings_match_actual_resample_at_every_bayer_site() {
    for cfa in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        let raw = spatial_raw(69, 63, cfa);
        let gains = SensorGains::for_raw(&raw, (0, 0), 1).unwrap();
        let mut mosaic = Image::new(raw.width, raw.height, ColorSpace::CameraNativeMosaic);
        for (i, px) in mosaic.pixels.iter_mut().enumerate() {
            let (x, y) = (i as u32 % raw.width, i as u32 / raw.width);
            px[cfa.color_at(x, y) as usize] = gains.sample(x as i32, y as i32);
        }
        let fits = (
            RadialFit { a1: 1.2, a3: 0.8 },
            RadialFit { a1: -1.9, a3: 0.6 },
        );
        let frame = RadialFrame::new(raw.width as usize, raw.height as usize);
        for (color, fit) in [(0, fits.0), (2, fits.1)] {
            let channel = ChannelSampler::build(&mosaic, cfa, color).unwrap();
            resample_channel(&mut mosaic, cfa, &channel, frame, fit, color);
        }
        let transported = gains.with_ca(CaCalibration::new(raw.width, raw.height, fits));
        for (i, px) in mosaic.pixels.iter().enumerate() {
            let (x, y) = (i as u32 % raw.width, i as u32 / raw.width);
            let c = cfa.color_at(x, y) as usize;
            assert_eq!(
                transported.sample(x as i32, y as i32),
                px[c],
                "{cfa:?} {x},{y}"
            );
            assert_eq!(transported.rgb(x, y)[c], px[c]);
            if c == 1 {
                assert_eq!(px[c], gains.sample(x as i32, y as i32));
            }
        }
        let half = transported.at_resolution(2);
        for y in 0..raw.height / 2 {
            for x in 0..raw.width / 2 {
                let mut expected = [0.; 3];
                for dy in 0..2 {
                    for dx in 0..2 {
                        let (sx, sy) = (2 * x + dx, 2 * y + dy);
                        let c = cfa.color_at(sx, sy) as usize;
                        expected[c] += mosaic.pixels[(sy * raw.width + sx) as usize][c]
                            * if c == 1 { 0.5 } else { 1. };
                    }
                }
                assert_eq!(half.rgb(x, y), expected);
            }
        }
        assert!(CaCalibration::new(
            raw.width,
            raw.height,
            (RadialFit::default(), RadialFit::default())
        )
        .is_none());
    }
}

#[test]
fn sized_camera_prefix_retains_the_estimated_ca_field_for_recovery() {
    use crate::{
        cancel::CancelToken,
        demosaic, linearize, pipeline,
        stages::{highlight_recovery, white_balance},
        xmp::{AdjustmentModel, HighlightRecoveryMode},
    };
    let mut raw = spatial_raw(512, 384, CfaPattern::Rggb);
    raw.black_level = [0; 4];
    raw.white_level = 10000;
    raw.as_shot_neutral = [0.6, 1., 1.4];
    raw.baseline_exposure = 0.;
    let source = super::tests::synthetic_mosaic(0.003, -0.002);
    for (i, sample) in raw.raw_data.iter_mut().enumerate() {
        let c = raw.cfa.color_at(i as u32 % raw.width, i as u32 / raw.width) as usize;
        *sample = (source.pixels[i][c] * 15000.).min(10000.) as u16;
    }
    let model = AdjustmentModel {
        auto_lateral_ca: AutoLateralCa::On,
        highlight_recovery: HighlightRecoveryMode::ChromaticAdaptation,
        ..Default::default()
    };
    let mut mosaic = linearize::sensor_linearize(&raw);
    let fits = apply(
        &mut mosaic,
        raw.cfa,
        AutoLateralCa::On,
        CancelToken::never(),
    );
    assert!(
        fits.0.is_useful() && fits.1.is_useful(),
        "nontrivial fitted field: {fits:?}"
    );
    let gains = SensorGains::for_raw(&raw, (0, 0), 1)
        .unwrap()
        .with_ca(CaCalibration::new(raw.width, raw.height, fits));
    for (max_edge, divisor) in [(512, 1), (256, 2)] {
        let mut expected = if divisor == 2 {
            demosaic::half_res_cancellable(&mosaic, raw.cfa, CancelToken::never())
        } else {
            demosaic::demosaic_calibrated_cancellable(
                pipeline::bayer_kernel(pipeline::RenderQuality::Amaze, &model, &raw),
                &mosaic,
                raw.cfa,
                raw.as_shot_neutral,
                Some(gains),
                CancelToken::never(),
            )
        };
        white_balance::apply_pre_gain(&mut expected, raw.as_shot_neutral);
        let mut untransported = expected.clone();
        highlight_recovery::apply_calibrated_in_region(
            &mut untransported,
            model.highlight_recovery,
            raw.as_shot_neutral,
            0.,
            None,
            None,
            SensorGains::for_raw(&raw, (0, 0), divisor),
        );
        highlight_recovery::apply_calibrated_in_region(
            &mut expected,
            model.highlight_recovery,
            raw.as_shot_neutral,
            0.,
            None,
            None,
            Some(gains.at_resolution(divisor)),
        );
        assert!(
            expected
                .pixels
                .iter()
                .zip(&untransported.pixels)
                .any(|(a, b)| a.iter().zip(b).any(|(x, y)| (x - y).abs() > 1e-6)),
            "fixture must detect lost CA calibration at divisor {divisor}"
        );
        let actual = pipeline::develop_camera_sized_from_raw(
            &raw,
            &model,
            pipeline::RenderQuality::Amaze,
            max_edge,
            CancelToken::never(),
        )
        .unwrap();
        assert_eq!(
            (actual.width, actual.height),
            (expected.width, expected.height)
        );
        assert_eq!(
            actual.pixels, expected.pixels,
            "prefix at divisor {divisor}"
        );
    }
}

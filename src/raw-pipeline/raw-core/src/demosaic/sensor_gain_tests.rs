use crate::{
    decode::decode_bytes,
    demosaic::{amaze::amaze_with_gains, camera_demosaic_cancellable, DemosaicAlgorithm},
    image::{ColorSpace, Image},
    sensor_gain_maps::ClipGainContext,
    test_support::{
        gain_map::{blob, map},
        synth_dng::SyntheticGreyDng,
    },
};

#[test]
fn gained_sites_above_the_sensor_ceiling_reconstruct_as_unclipped_detail() {
    let raw = decode_bytes(
        &SyntheticGreyDng {
            opcode_list2: Some(blob(
                &[0, 1].map(|y| [0, 1].map(|x| map(y, x, 2.))).concat(),
            )),
            ..Default::default()
        }
        .write_to_bytes(),
        "dng",
    )
    .unwrap();
    let gains = ClipGainContext::new(&raw, (0, 0), 1).unwrap();
    let (width, height) = (raw.width, raw.height);
    let mut ungained = Image::new(width, height, ColorSpace::CameraNativeMosaic);
    for (i, pixel) in ungained.pixels.iter_mut().enumerate() {
        let (x, y) = (i as u32 % width, i as u32 / width);
        pixel[raw.cfa.color_at(x, y) as usize] =
            0.5 + 0.1 * ((x as f32 * 0.9).sin() * (y as f32 * 0.7).cos());
    }
    let gained = Image {
        pixels: ungained.pixels.iter().map(|p| p.map(|v| v * 2.)).collect(),
        ..ungained.clone()
    };
    let scales = [1.; 3];
    let expected: Vec<_> = amaze_with_gains(&ungained, raw.cfa, scales)
        .pixels
        .into_iter()
        .map(|p| p.map(|v| v * 2.))
        .collect();
    let actual = camera_demosaic_cancellable(
        DemosaicAlgorithm::Amaze,
        &gained,
        raw.cfa,
        [1.; 3],
        Some(gains),
        crate::cancel::CancelToken::never(),
    );
    assert_eq!(actual.pixels, expected);
    let clipped = amaze_with_gains(&gained, raw.cfa, scales);
    assert_ne!(
        clipped.pixels, expected,
        "gained detail must cross the clip model"
    );
}

#[test]
fn per_phase_gains_scale_each_reconstructed_channel_by_its_quad_gain() {
    let raw = decode_bytes(
        &SyntheticGreyDng {
            opcode_list2: Some(blob(&[
                map(0, 0, 2.),
                map(0, 1, 3.),
                map(1, 0, 4.),
                map(1, 1, 5.),
            ])),
            ..Default::default()
        }
        .write_to_bytes(),
        "dng",
    )
    .unwrap();
    let gains = ClipGainContext::new(&raw, (0, 0), 1).unwrap();
    let site_gains = gains.site_gains(raw.width, raw.height);
    let mut gained = Image::new(raw.width, raw.height, ColorSpace::CameraNativeMosaic);
    for (i, pixel) in gained.pixels.iter_mut().enumerate() {
        let (x, y) = (i as u32 % raw.width, i as u32 / raw.width);
        pixel[raw.cfa.color_at(x, y) as usize] = 0.4 * site_gains[i];
    }
    let out = camera_demosaic_cancellable(
        DemosaicAlgorithm::Amaze,
        &gained,
        raw.cfa,
        [1.; 3],
        Some(gains),
        crate::cancel::CancelToken::never(),
    );
    let quad = |c: usize| {
        let phases: Vec<_> = (0..4u32)
            .filter(|p| raw.cfa.color_at(p % 2, p / 2) as usize == c)
            .map(|p| site_gains[(p / 2 * raw.width + p % 2) as usize])
            .collect();
        phases.iter().sum::<f32>() / phases.len() as f32
    };
    for (i, pixel) in out.pixels.iter().enumerate() {
        let (x, y) = (i as u32 % raw.width, i as u32 / raw.width);
        let own = raw.cfa.color_at(x, y) as usize;
        for c in 0..3 {
            let expected = if c == own {
                gained.pixels[i][c]
            } else {
                0.4 * quad(c)
            };
            assert!((pixel[c] - expected).abs() < 1e-5, "{i} {c}: {pixel:?}");
        }
    }
}

#[test]
fn odd_frames_keep_every_channel_gain_at_the_last_row_and_column() {
    use crate::{
        demosaic::{amaze::amaze_with_sensor_gains, dual::dual_amaze_vng4_with_gains},
        image::CfaPattern,
    };
    let (w, h) = (19u32, 21u32);
    for cfa in [
        CfaPattern::Rggb,
        CfaPattern::Bggr,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
    ] {
        let mut gained = Image::new(w, h, ColorSpace::CameraNativeMosaic);
        for (i, pixel) in gained.pixels.iter_mut().enumerate() {
            pixel[cfa.color_at(i as u32 % w, i as u32 / w) as usize] = 0.4 * 2.;
        }
        let site_gains = vec![2.; (w * h) as usize];
        for out in [
            amaze_with_sensor_gains(&gained, cfa, [1.; 3], Some(&site_gains)),
            dual_amaze_vng4_with_gains(&gained, cfa, [1.; 3], Some(&site_gains)),
        ] {
            for (i, pixel) in out.pixels.iter().enumerate() {
                assert!(
                    pixel.iter().all(|v| (v - 0.8).abs() < 1e-5),
                    "{cfa:?} {i}: {pixel:?}"
                );
            }
        }
    }
}

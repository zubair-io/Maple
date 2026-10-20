use super::{reconstruct_ungained, ClipGainContext};
use crate::{
    decode::decode_bytes,
    demosaic::{amaze::amaze_with_gains, camera_demosaic_cancellable, DemosaicAlgorithm},
    image::{ColorSpace, Image},
    sensor_gain_maps::tests::{blob, map},
    test_support::synth_dng::SyntheticGreyDng,
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
    let direct = reconstruct_ungained(&gained, raw.cfa, gains, |m| {
        amaze_with_gains(m, raw.cfa, scales)
    });
    assert_eq!(direct.pixels, actual.pixels);
}

use super::*;
use moxcms::{ColorProfile, ToneReprCurve};
use tiff::{encoder::colortype::RGB32Float, tags::Tag};

#[test]
fn linear_float_icc_input_preserves_signed_range_and_fine_precision() {
    let mut profile = ColorProfile::new_srgb();
    profile.cicp = None;
    profile.red_trc = Some(ToneReprCurve::Lut(vec![]));
    profile.green_trc = profile.red_trc.clone();
    profile.blue_trc = profile.red_trc.clone();
    let icc = profile.encode().unwrap();
    let samples = [1.5, -0.125, 0.0005, 0.5005, 0.5, 0.5005];
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut encoder = tiff::encoder::TiffEncoder::new(&mut bytes).unwrap();
        let mut image = encoder.new_image::<RGB32Float>(2, 1).unwrap();
        image
            .encoder()
            .write_tag(Tag::IccProfile, icc.as_slice())
            .unwrap();
        image.write_data(&samples).unwrap();
    }
    let (scene, _) = decode(&bytes.into_inner()).unwrap();
    for (input, actual) in samples.chunks_exact(3).zip(scene.pixels.iter()) {
        let expected = M_SRGB_TO_REC2020.mul_vec(input.try_into().unwrap());
        for channel in 0..3 {
            assert!(
                (actual[channel] - expected[channel]).abs() < 0.001,
                "channel {channel}: {} vs {}",
                actual[channel],
                expected[channel]
            );
        }
    }
}

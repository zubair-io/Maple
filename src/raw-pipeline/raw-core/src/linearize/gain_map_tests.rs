use super::{sensor_gains::SensorGains, GainMaps};
pub(crate) fn payload(
    area: [i32; 4],
    pitch: [u32; 2],
    points: [u32; 2],
    spacing: [f64; 2],
    origin: [f64; 2],
    gains: &[f32],
) -> Vec<u8> {
    let mut p = Vec::new();
    for v in area {
        p.extend(v.to_be_bytes());
    }
    for v in [0, 1, pitch[0], pitch[1], points[0], points[1]] {
        p.extend(v.to_be_bytes());
    }
    for v in spacing.into_iter().chain(origin) {
        p.extend(v.to_be_bytes());
    }
    p.extend(1u32.to_be_bytes());
    for v in gains {
        p.extend(v.to_be_bytes());
    }
    p
}
pub(crate) fn list(ops: &[(u32, u32, Vec<u8>)]) -> Vec<u8> {
    let mut v = (ops.len() as u32).to_be_bytes().to_vec();
    for (id, flags, p) in ops {
        for n in [*id, 0x01030000, *flags, p.len() as u32] {
            v.extend(n.to_be_bytes());
        }
        v.extend(p);
    }
    v
}
#[test]
fn analytical_bilinear_pixel_centers_and_edges() {
    let m = GainMaps::parse(&list(&[(
        9,
        0,
        payload(
            [0, 0, 0, 0],
            [1, 1],
            [2, 2],
            [0.5; 2],
            [0.25; 2],
            &[1., 3., 5., 7.],
        ),
    )]))
    .unwrap()
    .unwrap();
    assert_eq!(m.gain(1, 1, 4, 4), 2.5);
    assert_eq!(m.gain(0, 0, 4, 4), 1.);
    assert_eq!(m.gain(3, 3, 4, 4), 7.);
}
#[test]
fn phase_area_and_order() {
    let p = payload([1, 0, 5, 6], [2, 2], [1, 1], [0.; 2], [999.; 2], &[2.]);
    let m = GainMaps::parse(&list(&[(9, 0, p.clone()), (9, 0, p)]))
        .unwrap()
        .unwrap();
    for y in 0..6 {
        for x in 0..7 {
            assert_eq!(
                m.gain(x, y, 7, 6),
                if y < 5 && y % 2 == 1 && x < 6 && x % 2 == 0 {
                    4.
                } else {
                    1.
                }
            );
        }
    }
}
#[test]
fn truncation_unknown_required_nonfinite_and_overflow() {
    let p = payload([0; 4], [1, 1], [1, 1], [1.; 2], [0.; 2], &[1.]);
    let b = list(&[(9, 0, p.clone())]);
    for n in 0..b.len() {
        assert!(GainMaps::parse(&b[..n]).is_err(), "{n}");
    }
    assert!(GainMaps::parse(&list(&[(77, 0, p.clone())])).is_err());
    assert!(GainMaps::parse(&list(&[(77, 1, p.clone())]))
        .unwrap()
        .is_none());
    for bad in [0., -1., f32::INFINITY, f32::NAN] {
        assert!(GainMaps::parse(&list(&[(
            9,
            0,
            payload([0; 4], [1, 1], [1, 1], [1.; 2], [0.; 2], &[bad])
        )]))
        .is_err());
    }
    let mut huge = p;
    huge[32..36].copy_from_slice(&u32::MAX.to_be_bytes());
    huge[36..40].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(GainMaps::parse(&list(&[(9, 0, huge)])).is_err());
    let mut trailing = b;
    trailing.push(0);
    assert!(GainMaps::parse(&trailing).is_err());
}

pub(crate) fn calibrated_raw(width: u32, height: u32) -> crate::image::RawImage {
    let mut r = super::tests::tiny_raw(vec![8000; (width * height) as usize], width, height);
    r.white_level = 10000;
    r.black_level = [1000; 4];
    r.sensor_gain_maps = GainMaps::parse(&list(&[(
        9,
        0,
        payload([0; 4], [1, 1], [1, 1], [1.; 2], [0.; 2], &[2.]),
    )]))
    .unwrap();
    r
}

#[test]
fn sensor_gain_preserves_headroom_and_region_coordinates() {
    let mut r = calibrated_raw(32, 32);
    r.sensor_gain_maps = GainMaps::parse(&list(&[(
        9,
        0,
        payload([0; 4], [1, 1], [2, 2], [1.; 2], [0.; 2], &[1., 2., 3., 4.]),
    )]))
    .unwrap();
    let full = super::sensor_linearize(&r);
    let tile = super::sensor_linearize_region(&r, 6, 8, 14, 12);
    for y in 0..12 {
        for x in 0..14 {
            assert_eq!(
                tile.pixels[(y * 14 + x) as usize],
                full.pixels[((y + 8) * 32 + x + 6) as usize]
            );
        }
    }
    assert!(full.pixels.iter().flatten().any(|v| *v > 1.));
    let a = SensorGains::for_raw(&r, (0, 0), 1).unwrap();
    let b = SensorGains::for_raw(&r, (6, 8), 1).unwrap();
    for y in 0..12 {
        for x in 0..14 {
            assert_eq!(a.rgb(x + 6, y + 8), b.rgb(x, y));
        }
    }
}

#[test]
fn each_cfa_phase_and_half_resolution_footprint_are_preserved() {
    let mut r = calibrated_raw(32, 32);
    let ops: Vec<_> = (0..4)
        .map(|i| {
            (
                9,
                0,
                payload(
                    [i / 2, i % 2, 32, 32],
                    [2; 2],
                    [1; 2],
                    [1.; 2],
                    [0.; 2],
                    &[i as f32 + 1.],
                ),
            )
        })
        .collect();
    r.sensor_gain_maps = GainMaps::parse(&list(&ops)).unwrap();
    let g = SensorGains::for_raw(&r, (0, 0), 1).unwrap();
    let half = SensorGains::for_raw(&r, (0, 0), 2).unwrap();
    assert_eq!(g.rgb(10, 10), [1., 2.5, 4.]);
    assert_eq!(g.rgb(11, 10), [1., 2., 4.]);
    assert_eq!(g.rgb(10, 11), [1., 3., 4.]);
    assert_eq!(half.rgb(5, 5), [1., 2.5, 4.]);
}

#[test]
fn highlight_recovery_keeps_amplified_unclipped_samples_and_recovers_real_clip() {
    use crate::{
        image::{ColorSpace, Image},
        stages::highlight_recovery,
        xmp::HighlightRecoveryMode,
    };
    let r = calibrated_raw(32, 32);
    let cal = SensorGains::for_raw(&r, (0, 0), 1);
    let mut img = Image::new(32, 32, ColorSpace::CameraNativeLinearRgb);
    img.pixels.fill([1.4, 1.5, 1.6]);
    let original = img.pixels.clone();
    highlight_recovery::apply_calibrated_in_region(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        [1.; 3],
        0.,
        None,
        None,
        cal,
    );
    assert_eq!(
        img.pixels, original,
        "gain-amplified samples are not sensor clips"
    );
    let i = 16 * 32 + 16;
    img.pixels[i][0] = 2.;
    highlight_recovery::apply_calibrated_in_region(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        [1.; 3],
        0.,
        None,
        None,
        cal,
    );
    assert!(img.pixels[i][0] < 1.7);
    assert_eq!(&img.pixels[i][1..], &original[i][1..]);
}

#[test]
fn active_area_origin_precedes_gain_map_and_default_crop() {
    let mut r = calibrated_raw(32, 32);
    r.lens_metadata.active_area = Some(crate::pipeline::pano::opcodes::ActiveAreaRect {
        top: 4,
        left: 6,
        width: 20,
        height: 24,
    });
    r.sensor_gain_maps = GainMaps::parse(&list(&[(
        9,
        0,
        payload([0; 4], [1, 1], [2, 2], [1.; 2], [0.; 2], &[1., 3., 5., 7.]),
    )]))
    .unwrap();
    let g = SensorGains::for_raw(&r, (0, 0), 1).unwrap();
    assert_eq!(g.sample(5, 4), 1.);
    let expected = 1. + 2. * 0.5 / 20. + 4. * 0.5 / 24.;
    assert!((g.sample(6, 4) - expected).abs() < 1e-6);
}

#[test]
#[ignore = "requires test_0015.dng physical fixture"]
fn physical_pixel_declared_gain_maps_decode_and_preserve_saturation_count() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0015.dng");
    let r = crate::decode::decode(&path).expect("required Pixel fixture");
    let cal = SensorGains::for_raw(&r, (0, 0), 1).expect("required GainMap metadata");
    let img = super::sensor_linearize(&r);
    let mut original_clips = 0;
    let mut false_old_clips = 0;
    for (i, p) in img.pixels.iter().enumerate() {
        let (x, y) = ((i % r.width as usize) as u32, (i / r.width as usize) as u32);
        let c = r.cfa.color_at(x, y) as usize;
        let gain = cal.sample(x as i32, y as i32);
        let clipped = u32::from(r.raw_data[i]) >= r.white_level;
        original_clips += usize::from(clipped);
        false_old_clips += usize::from(!clipped && p[c] >= 1.);
        if clipped {
            assert_eq!(p[c], gain);
        } else {
            assert!(p[c] < gain);
        }
    }
    assert_eq!(original_clips, 131);
    assert_eq!(false_old_clips, 2037);
}

#[test]
fn amaze_calibration_preserves_measured_hdr_channels() {
    let r = calibrated_raw(64, 64);
    let mosaic = super::sensor_linearize(&r);
    let image = crate::demosaic::demosaic_calibrated_cancellable(
        crate::demosaic::DemosaicAlgorithm::Amaze,
        &mosaic,
        r.cfa,
        [1.; 3],
        SensorGains::for_raw(&r, (0, 0), 1),
        crate::CancelToken::never(),
    );
    for (i, p) in image.pixels.iter().enumerate() {
        let c = r.cfa.color_at(i as u32 % r.width, i as u32 / r.width) as usize;
        assert_eq!(p[c], mosaic.pixels[i][c]);
        assert!(p.iter().all(|v| v.is_finite() && *v > 1.0));
    }
}

#[test]
fn gain_map_plane_ranges_follow_the_single_sensor_plane() {
    let mut p = payload([0; 4], [1; 2], [1; 2], [1.; 2], [0.; 2], &[2.]);
    p[20..24].copy_from_slice(&3u32.to_be_bytes());
    let m = GainMaps::parse(&list(&[(9, 0, p.clone())]))
        .unwrap()
        .unwrap();
    assert_eq!(m.gain(0, 0, 4, 4), 2.);
    p[16..20].copy_from_slice(&1u32.to_be_bytes());
    let m = GainMaps::parse(&list(&[(9, 0, p.clone())]))
        .unwrap()
        .unwrap();
    assert_eq!(m.gain(0, 0, 4, 4), 1.);
    p[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(GainMaps::parse(&list(&[(9, 0, p)])).is_err());
}

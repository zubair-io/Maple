use super::*;
use crate::{
    decode::decode_bytes,
    linearize::{linearraw_to_camera_rgb, sensor_linearize},
    pipeline::pano::opcodes::{parse_opcode_list, OpcodeListKind, SkipReason},
    test_support::{
        gain_map::{entry, gain_entry, map, opcode_list, polynomial_entry},
        synth_dng::SyntheticGreyDng,
    },
    CfaPattern,
};

const RED_BLUE: [f64; 4] = [0., 0.0625, 0., 0.9375];
const GREEN: [f64; 4] = [0.01, 0.0625, 0., 0.9275];

fn polynomial(coefficients: &[f64]) -> MapPolynomialOpcode {
    let list = parse_opcode_list(
        &opcode_list(&[polynomial_entry([0, 0, 64, 64], 0, 1, coefficients)]),
        OpcodeListKind::List2,
    );
    match &list.opcodes[..] {
        [PanoOpcode::MapPolynomial(p)] => p.clone(),
        other => panic!("{other:?}"),
    }
}

fn decode_with_list2(entries: &[Vec<u8>]) -> RawImage {
    let fixture = SyntheticGreyDng {
        opcode_list2: Some(opcode_list(entries)),
        ..Default::default()
    };
    decode_bytes(&fixture.write_to_bytes(), "dng").unwrap()
}

fn as_linear_raw(mut raw: RawImage, white_level: u32) -> RawImage {
    raw.cfa = CfaPattern::LinearRgb;
    raw.black_level = [0; 4];
    raw.white_level = white_level;
    raw.raw_data = vec![(white_level + 1) as u16 / 2; raw.width as usize * raw.height as usize * 3];
    raw
}

#[test]
fn the_declared_lossy_dng_transfer_matches_its_specified_values() {
    let transfer = polynomial(&RED_BLUE);
    assert_eq!(transfer.coefficients, RED_BLUE);
    assert!(transfer.required);
    assert_eq!(transfer.evaluate(0.5), 0.1484375);
    assert_eq!(transfer.evaluate(0.), 0.);
    assert_eq!(transfer.evaluate(1.), 1.);
}

#[test]
fn the_transfer_input_and_output_are_pinned_to_the_unit_range() {
    let steep = polynomial(&[-0.5, 2.]);
    assert_eq!(steep.evaluate(0.), 0.);
    assert_eq!(steep.evaluate(0.5), 0.5);
    assert_eq!(steep.evaluate(1.), 1.);
    let dipping = polynomial(&[0., 4., -3.]);
    assert_eq!(dipping.evaluate(1.), 1.);
    assert_eq!(
        dipping.evaluate(1.5),
        1.,
        "evaluated at 1, not extrapolated"
    );
}

#[test]
fn the_transfer_range_bound_encloses_every_value_it_can_produce() {
    let wavy = polynomial(&[0.2, 3., -9., 6.5]);
    for (low, high) in [(0., 1.), (0.3, 0.6), (0.9, 1.)] {
        let (min, max) = wavy.range_over(low, high);
        let values = (0..=10_000).map(|i| wavy.evaluate(low + (high - low) * i as f32 / 10_000.));
        for v in values {
            assert!(min <= v && v <= max, "{v} outside [{min}, {max}]");
        }
        assert!(max - min < 1.);
    }
}

#[test]
fn consecutive_gains_meet_the_value_as_one_product() {
    let maps = [map(0, 0, 1.3), map(0, 0, 1.7)];
    let raw = decode_with_list2(&maps.iter().map(gain_entry).collect::<Vec<_>>());
    let plain = sensor_linearize(&decode_with_list2(&[]));
    let v = plain.pixels[0][0];
    assert_eq!(sensor_linearize(&raw).pixels[0][0], v * (1.3f32 * 1.7));
}

#[test]
fn malformed_map_polynomials_are_skipped_without_dropping_their_neighbours() {
    let gain = gain_entry(&map(0, 0, 2.));
    let malformed = |coefficients: &[f64], area: [u32; 4]| {
        let list = parse_opcode_list(
            &opcode_list(&[
                gain.clone(),
                polynomial_entry(area, 0, 1, coefficients),
                gain.clone(),
            ]),
            OpcodeListKind::List2,
        );
        assert_eq!(list.opcodes.len(), 2);
        list.skipped
    };
    let expected = [SkippedOpcode {
        list: OpcodeListKind::List2,
        id: Some(8),
        required: true,
        reason: SkipReason::Malformed,
    }];
    assert_eq!(malformed(&[0.; 10], [0, 0, 64, 64]), expected, "degree 9");
    assert_eq!(malformed(&[f64::NAN, 1.], [0, 0, 64, 64]), expected);
    assert_eq!(malformed(&[0., 1.], [0, 0, 0, 64]), expected, "empty area");
}

/// #5081: 8-bit lossy LinearRaw is decoded by its own declared transfers —
/// not a guessed gamma — and nothing it declares is left unexecuted.
#[test]
fn lossy_linear_raw_is_decoded_by_its_declared_transfers() {
    let declared = [
        polynomial_entry([0, 0, 64, 64], 0, 1, &RED_BLUE),
        polynomial_entry([0, 0, 64, 64], 1, 1, &GREEN),
        entry(
            8,
            1,
            &polynomial_entry([0, 0, 64, 64], 2, 1, &RED_BLUE)[16..],
        ),
    ];
    let raw = as_linear_raw(decode_with_list2(&declared), 255);
    let encoded = 128f32 / 255.;
    let image = linearraw_to_camera_rgb(&raw).unwrap();
    let expected = [
        polynomial(&RED_BLUE).evaluate(encoded),
        polynomial(&GREEN).evaluate(encoded),
        polynomial(&RED_BLUE).evaluate(encoded),
    ];
    assert!(image.pixels.iter().all(|pixel| *pixel == expected));
    assert!(
        expected[0] < encoded.powf(2.4) * 0.9,
        "the declared transfer, not the gamma 2.4 guess"
    );
    assert!(raw.skipped_required_opcodes().is_empty());
    assert!(ClipGainContext::new(&raw, (0, 0), 1).is_some());
}

/// An 8-bit LinearRaw plane no declared transfer covers keeps the legacy
/// gamma 2.4 decode instead of rendering un-linearized: with no OpcodeList2,
/// and on the plane whose required transfer was skipped as malformed (the
/// other planes still run theirs). High-bit-depth data without a transfer is
/// linear (DNG spec) and passes through.
#[test]
fn an_8bit_plane_without_an_executed_transfer_keeps_the_gamma_fallback() {
    let encoded = 128f32 / 255.;
    let bare = linearraw_to_camera_rgb(&as_linear_raw(decode_with_list2(&[]), 255)).unwrap();
    assert!(bare.pixels.iter().all(|p| *p == [encoded.powf(2.4); 3]));

    let malformed_red = [
        polynomial_entry([0, 0, 64, 64], 0, 1, &[0.; 10]),
        polynomial_entry([0, 0, 64, 64], 1, 1, &GREEN),
        polynomial_entry([0, 0, 64, 64], 2, 1, &RED_BLUE),
    ];
    let raw = as_linear_raw(decode_with_list2(&malformed_red), 255);
    assert_eq!(raw.skipped_required_opcodes().len(), 1);
    let image = linearraw_to_camera_rgb(&raw).unwrap();
    let expected = [
        encoded.powf(2.4),
        polynomial(&GREEN).evaluate(encoded),
        polynomial(&RED_BLUE).evaluate(encoded),
    ];
    assert!(image.pixels.iter().all(|p| *p == expected));

    let high_bit = linearraw_to_camera_rgb(&as_linear_raw(decode_with_list2(&[]), 4095)).unwrap();
    let linear = 2048f32 / 4095.;
    assert!(high_bit.pixels.iter().all(|p| *p == [linear; 3]));
}

#[test]
fn high_bit_linear_raw_applies_each_plane_transfer_only_inside_its_area() {
    let declared = [
        polynomial_entry([0, 0, 32, 64], 0, 1, &RED_BLUE),
        polynomial_entry([0, 0, 64, 64], 1, 1, &GREEN),
    ];
    let raw = as_linear_raw(decode_with_list2(&declared), 4095);
    let encoded = 2048f32 / 4095.;
    let at = |c: &[f64]| {
        let x = f64::from(encoded);
        c.iter().rev().fold(0., |sum, c| sum * x + c) as f32
    };
    let image = linearraw_to_camera_rgb(&raw).unwrap();
    for (i, pixel) in image.pixels.iter().enumerate() {
        let red = if i / 64 < 32 { at(&RED_BLUE) } else { encoded };
        assert_eq!(*pixel, [red, at(&GREEN), encoded], "{i}");
    }
    assert!(raw.skipped_required_opcodes().is_empty());
}

#[test]
fn bayer_steps_run_in_list_order() {
    let square = polynomial_entry([0, 0, 64, 64], 0, 1, &[0., 0., 1.]);
    let double = gain_entry(&map(0, 0, 2.));
    let transfer_first = decode_with_list2(&[square.clone(), double.clone()]);
    let gain_first = decode_with_list2(&[double, square]);
    let plain = sensor_linearize(&decode_with_list2(&[]));
    let (a, b) = (
        sensor_linearize(&transfer_first),
        sensor_linearize(&gain_first),
    );
    let site = 0;
    let v = plain.pixels[site][0];
    assert!(v > 0. && v < 0.5, "{v}");
    let square = |x: f32| (f64::from(x) * f64::from(x)) as f32;
    assert_eq!(a.pixels[site][0], square(v) * 2.);
    assert_eq!(b.pixels[site][0], square(v * 2.));
}

#[test]
fn a_bayer_transfer_moves_the_clip_level_at_the_sites_it_covers() {
    let lower = polynomial_entry([0, 0, 32, 64], 0, 1, &[0., 0.5]);
    let raw = decode_with_list2(&[lower]);
    let context = ClipGainContext::new(&raw, (0, 0), 1).expect("transfer executes");
    let saturation = context.site_gains(64, 64);
    assert_eq!(saturation[0], 0.5);
    assert_eq!(saturation[40 * 64], 1.);
    let floor = context.minimum_scale();
    assert!(
        floor > 0.49 && saturation.iter().all(|&s| floor <= s),
        "{floor}"
    );
}

/// #4647: the image still decodes and renders its supported steps, and
/// each required entry it cannot run is surfaced; optional ones are not.
#[test]
fn unsupported_and_malformed_required_opcodes_render_and_are_surfaced() {
    let truncated_gain = {
        let mut e = gain_entry(&map(0, 0, 2.));
        let body_len = e.len() as u32 - 16 - 4;
        e[12..16].copy_from_slice(&body_len.to_be_bytes());
        e.truncate(e.len() - 4);
        e
    };
    let raw = decode_with_list2(&[
        entry(42, 0, &[0; 8]),
        entry(43, 1, &[0; 8]),
        gain_entry(&map(0, 0, 3.)),
        truncated_gain,
    ]);
    let skipped = |id, reason| SkippedOpcode {
        list: OpcodeListKind::List2,
        id: Some(id),
        required: true,
        reason,
    };
    assert_eq!(
        raw.skipped_required_opcodes(),
        [
            skipped(42, SkipReason::Unsupported),
            skipped(9, SkipReason::Malformed)
        ]
    );
    let mut control = raw.clone();
    control.sensor_gain_maps = None;
    assert_eq!(
        sensor_linearize(&raw).pixels[0][0],
        sensor_linearize(&control).pixels[0][0] * 3.
    );

    let clean = decode_with_list2(&[gain_entry(&map(0, 0, 3.))]);
    let mut blob = opcode_list(&[gain_entry(&map(0, 0, 3.))]);
    blob.truncate(blob.len() - 3);
    let cut = decode_bytes(
        &SyntheticGreyDng {
            opcode_list2: Some(blob),
            ..Default::default()
        }
        .write_to_bytes(),
        "dng",
    )
    .unwrap();
    assert!(cut.sensor_gain_maps.is_none());
    assert_eq!(
        cut.skipped_required_opcodes(),
        [skipped(9, SkipReason::Truncated)]
    );
    assert!(clean.skipped_required_opcodes().is_empty());
}

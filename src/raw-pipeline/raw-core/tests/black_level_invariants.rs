//! Per-channel black levels survive decode for the two CFA shapes rawler's
//! `BlackLevel::as_bayer_array` collapses — 3-channel LinearRaw and 6×6
//! X-Trans — and a flat frame sitting at each channel's own black
//! linearizes to zero in every channel (#4730). Synthesised in memory like
//! `grey_invariants`; never skips.

#![cfg(feature = "test-support")]

use raw_core::image::CfaPattern;
use raw_core::linearize::{linearraw_to_camera_rgb, sensor_linearize};
use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::test_support::synth_linearraw_dng::SyntheticLinearRawDng;
use raw_core::xmp::AdjustmentModel;

const XTRANS_PATTERN: [u8; 36] = [
    1, 1, 0, 1, 1, 2, //
    1, 1, 2, 1, 1, 0, //
    2, 0, 1, 0, 2, 1, //
    1, 1, 2, 1, 1, 0, //
    1, 1, 0, 1, 1, 2, //
    0, 2, 1, 2, 0, 1, //
];

const LINEARRAW_BLACK: [u16; 3] = [100, 200, 300];
const XTRANS_BLACK_BY_COLOUR: [u16; 3] = [1000, 1100, 1200];

#[test]
fn linearraw_per_channel_black_survives_decode() {
    let dng = SyntheticLinearRawDng {
        black_level: LINEARRAW_BLACK,
        ..Default::default()
    };
    let raw =
        raw_core::decode::decode_bytes(&dng.write_to_bytes(), "dng").expect("LinearRaw decodes");
    assert_eq!(raw.cfa, CfaPattern::LinearRgb);
    assert_eq!(raw.black_level, [100, 200, 300, 300]);
}

#[test]
fn linearraw_frame_at_black_linearizes_to_zero_in_every_channel() {
    let dng = SyntheticLinearRawDng {
        linear_value: 0.0,
        black_level: LINEARRAW_BLACK,
        ..Default::default()
    };
    assert_eq!(dng.raw_rgb(), LINEARRAW_BLACK);
    let raw =
        raw_core::decode::decode_bytes(&dng.write_to_bytes(), "dng").expect("LinearRaw decodes");
    let img = linearraw_to_camera_rgb(&raw).expect("LinearRaw linearizes");
    assert!(
        img.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]),
        "frame at per-channel black must read 0 in every channel, got {:?}",
        img.pixels[0]
    );
}

#[test]
fn linearraw_neutral_above_per_channel_black_stays_neutral() {
    let dng = SyntheticLinearRawDng {
        linear_value: 0.5,
        black_level: LINEARRAW_BLACK,
        ..Default::default()
    };
    let raw =
        raw_core::decode::decode_bytes(&dng.write_to_bytes(), "dng").expect("LinearRaw decodes");
    let img = linearraw_to_camera_rgb(&raw).expect("LinearRaw linearizes");
    for p in &img.pixels {
        for c in 0..3 {
            assert!(
                (p[c] - 0.5).abs() <= 2e-4,
                "channel {} read {} instead of 0.5 (pixel {:?})",
                c,
                p[c],
                p
            );
        }
    }

    let scene = develop_scene_linear_from_raw_with_quality(
        &raw,
        &AdjustmentModel::default(),
        RenderQuality::Full,
    )
    .expect("scene-linear render must succeed");
    for p in &scene.pixels {
        assert!(
            (p[0] - p[1]).abs() <= 5e-4 && (p[0] - p[2]).abs() <= 5e-4,
            "developed neutral carries a cast: {:?}",
            p
        );
    }
}

fn xtrans_black_table() -> Vec<u16> {
    XTRANS_PATTERN
        .iter()
        .map(|&c| XTRANS_BLACK_BY_COLOUR[c as usize])
        .collect()
}

#[test]
fn xtrans_six_by_six_black_table_reduces_to_per_colour_means() {
    let dng = SyntheticGreyDng {
        width: 48,
        height: 48,
        cfa: CfaPattern::XTrans(XTRANS_PATTERN),
        black_level_table: Some(xtrans_black_table()),
        ..Default::default()
    };
    let raw =
        raw_core::decode::decode_bytes(&dng.write_to_bytes(), "dng").expect("X-Trans decodes");
    assert_eq!(raw.cfa, CfaPattern::XTrans(XTRANS_PATTERN));
    assert_eq!(raw.black_level, [1000, 1100, 1200, 1200]);
}

/// DNG anchors both `CFAPattern` and `BlackLevel` at the `ActiveArea` origin.
/// rawler re-anchors the CFA to the sensor origin (`CFA::shift(left, top)`,
/// `S(r, c) = O(r + top, c + left)`) but leaves the table ActiveArea-relative,
/// so the table must be grouped by the unshifted pattern. An origin that is
/// not a multiple of 3 is where adding the origin instead of undoing it keys
/// cells to the wrong colour on a 6×6 tile.
#[test]
fn xtrans_black_table_is_grouped_by_the_unshifted_pattern_under_active_area() {
    for area in [[0u16, 1, 48, 48], [1, 2, 48, 48], [4, 5, 48, 48]] {
        let dng = SyntheticGreyDng {
            width: 48,
            height: 48,
            cfa: CfaPattern::XTrans(XTRANS_PATTERN),
            black_level_table: Some(xtrans_black_table()),
            active_area: Some(area),
            ..Default::default()
        };
        let raw =
            raw_core::decode::decode_bytes(&dng.write_to_bytes(), "dng").expect("X-Trans decodes");
        assert_eq!(
            raw.black_level,
            [1000, 1100, 1200, 1200],
            "ActiveArea {:?}: table cells grouped to the wrong colour",
            area
        );
    }
}

#[test]
fn xtrans_frame_at_per_colour_black_linearizes_to_zero() {
    let dng = SyntheticGreyDng {
        linear_value: 0.0,
        width: 48,
        height: 48,
        cfa: CfaPattern::XTrans(XTRANS_PATTERN),
        black_level_table: Some(xtrans_black_table()),
        ..Default::default()
    };
    let raw =
        raw_core::decode::decode_bytes(&dng.write_to_bytes(), "dng").expect("X-Trans decodes");
    let img = sensor_linearize(&raw);
    assert!(
        img.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]),
        "frame at per-colour black must read 0 at every site, got {:?}",
        img.pixels.iter().find(|p| **p != [0.0, 0.0, 0.0])
    );
}

#[test]
fn xtrans_neutral_above_per_colour_black_is_flat_per_site() {
    let dng = SyntheticGreyDng {
        linear_value: 0.25,
        width: 48,
        height: 48,
        cfa: CfaPattern::XTrans(XTRANS_PATTERN),
        black_level_table: Some(xtrans_black_table()),
        as_shot_neutral_override: Some([1.0, 1.0, 1.0]),
        ..Default::default()
    };
    let raw =
        raw_core::decode::decode_bytes(&dng.write_to_bytes(), "dng").expect("X-Trans decodes");
    let img = sensor_linearize(&raw);
    for (i, p) in img.pixels.iter().enumerate() {
        let colour = XTRANS_PATTERN[((i / 48) % 6) * 6 + (i % 48) % 6] as usize;
        assert!(
            (p[colour] - 0.25).abs() <= 2e-4,
            "site {} (colour {}) read {} instead of 0.25",
            i,
            colour,
            p[colour]
        );
    }
}

#[test]
fn bayer_four_entry_black_table_is_still_positional() {
    let dng = SyntheticGreyDng {
        width: 16,
        height: 16,
        black_level_table: Some(vec![10, 20, 30, 40]),
        ..Default::default()
    };
    let raw = raw_core::decode::decode_bytes(&dng.write_to_bytes(), "dng").expect("Bayer decodes");
    assert_eq!(raw.black_level, [10, 20, 30, 40]);
}

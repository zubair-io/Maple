//! Reduces the black-level table rawler decodes (`levels` laid out as
//! `height × width × cpp`, row-major, channel-interleaved) to the four slots
//! of [`RawImage::black_level`](crate::image::RawImage::black_level).
//!
//! Slot layout depends on the CFA:
//! - 2×2 Bayer: one slot per tile position, `[top-left, top-right,
//!   bottom-left, bottom-right]`, read back by `(y & 1) * 2 + (x & 1)`.
//! - X-Trans and LinearRgb: one slot per colour, `[R, G, B, B]`, read back
//!   by the CFA colour at the site (X-Trans) or the channel (LinearRgb).
//!
//! rawler's own `BlackLevel::as_bayer_array` collapses any table that is
//! not exactly four entries to `[levels[0]; 4]`, which discards the
//! per-channel black of 3-channel LinearRaw DNGs and the 36-entry 6×6
//! X-Trans table (#4730). Only genuinely per-position data is kept
//! positional; everything else reduces to per-colour or uniform means.

use crate::image::CfaPattern;

/// `table_origin` is the sensor coordinate of the table's first cell —
/// `(0, 0)` unless the container keys the table to a cropped origin (DNG
/// keys `BlackLevel` to `ActiveArea`).
pub fn reduce_black_levels(
    levels: &[f32],
    cpp: usize,
    width: usize,
    height: usize,
    cfa: CfaPattern,
    table_origin: (u32, u32),
) -> [u32; 4] {
    let site_count = width * height;
    if levels.is_empty() || levels.len() != site_count * cpp {
        return [levels.first().map_or(0, |v| round(*v)); 4];
    }
    match (cfa, cpp, width, height) {
        (_, 3, _, _) => {
            let channel_mean = |c: usize| mean(levels.iter().skip(c).step_by(3));
            per_colour([channel_mean(0), channel_mean(1), channel_mean(2)])
        }
        (CfaPattern::XTrans(_), 1, 6, 6) => {
            let colour_of = |i: usize| {
                let (row, col) = ((i / 6) as u32, (i % 6) as u32);
                cfa.color_at(table_origin.0 + col, table_origin.1 + row) as usize
            };
            let colour_mean = |c: usize| {
                mean(
                    levels
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| colour_of(*i) == c)
                        .map(|(_, v)| v),
                )
            };
            per_colour([colour_mean(0), colour_mean(1), colour_mean(2)])
        }
        (cfa, 1, 2, 2) if cfa.is_bayer_2x2() => [
            round(levels[0]),
            round(levels[1]),
            round(levels[2]),
            round(levels[3]),
        ],
        _ => [round(mean(levels.iter())); 4],
    }
}

fn per_colour(rgb: [f32; 3]) -> [u32; 4] {
    // Slot 3 mirrors blue so a reader of the unused fourth slot sees a real
    // channel's black rather than a stray value.
    [round(rgb[0]), round(rgb[1]), round(rgb[2]), round(rgb[2])]
}

fn mean<'a>(values: impl Iterator<Item = &'a f32>) -> f32 {
    let (sum, count) = values.fold((0.0f64, 0usize), |(s, n), v| (s + *v as f64, n + 1));
    if count == 0 {
        0.0
    } else {
        (sum / count as f64) as f32
    }
}

fn round(v: f32) -> u32 {
    v.round() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const XTRANS_PATTERN: [u8; 36] = [
        1, 1, 0, 1, 1, 2, //
        1, 1, 2, 1, 1, 0, //
        2, 0, 1, 0, 2, 1, //
        1, 1, 2, 1, 1, 0, //
        1, 1, 0, 1, 1, 2, //
        0, 2, 1, 2, 0, 1, //
    ];

    #[test]
    fn bayer_four_entry_table_is_kept_per_position_unchanged() {
        let levels = [100.0, 200.0, 300.0, 400.0];
        assert_eq!(
            reduce_black_levels(&levels, 1, 2, 2, CfaPattern::Rggb, (0, 0)),
            [100, 200, 300, 400]
        );
        assert_eq!(
            reduce_black_levels(&levels, 1, 2, 2, CfaPattern::Gbrg, (0, 0)),
            [100, 200, 300, 400]
        );
    }

    #[test]
    fn single_entry_table_is_uniform() {
        assert_eq!(
            reduce_black_levels(&[511.6], 1, 1, 1, CfaPattern::Rggb, (0, 0)),
            [512; 4]
        );
    }

    #[test]
    fn linearraw_three_channel_table_lands_in_rgb_slots() {
        assert_eq!(
            reduce_black_levels(
                &[100.0, 200.0, 300.0],
                3,
                1,
                1,
                CfaPattern::LinearRgb,
                (0, 0)
            ),
            [100, 200, 300, 300]
        );
    }

    #[test]
    fn linearraw_repeated_table_averages_per_channel() {
        let levels = [100.0, 200.0, 300.0, 110.0, 210.0, 310.0];
        assert_eq!(
            reduce_black_levels(&levels, 3, 2, 1, CfaPattern::LinearRgb, (0, 0)),
            [105, 205, 305, 305]
        );
    }

    #[test]
    fn xtrans_table_reduces_to_per_colour_means() {
        let levels: Vec<f32> = XTRANS_PATTERN
            .iter()
            .enumerate()
            .map(|(i, &c)| {
                let base = [1000.0, 1100.0, 1200.0][c as usize];
                base + if i % 2 == 0 { -5.0 } else { 5.0 }
            })
            .collect();
        let reduced =
            reduce_black_levels(&levels, 1, 6, 6, CfaPattern::XTrans(XTRANS_PATTERN), (0, 0));
        assert_eq!(reduced, [1000, 1100, 1200, 1200]);
    }

    #[test]
    fn xtrans_table_origin_shifts_the_colour_keying() {
        let shifted = CfaPattern::XTrans(XTRANS_PATTERN);
        let levels: Vec<f32> = (0..36)
            .map(|i| {
                let (row, col) = ((i / 6) as u32, (i % 6) as u32);
                [1000.0, 1100.0, 1200.0][shifted.color_at(col + 2, row + 1) as usize]
            })
            .collect();
        assert_eq!(
            reduce_black_levels(&levels, 1, 6, 6, shifted, (2, 1)),
            [1000, 1100, 1200, 1200]
        );
    }

    #[test]
    fn mismatched_table_shapes_fall_back_to_the_mean() {
        let levels = [100.0, 200.0, 300.0, 400.0];
        assert_eq!(
            reduce_black_levels(&levels, 1, 2, 2, CfaPattern::XTrans(XTRANS_PATTERN), (0, 0)),
            [250; 4]
        );
        assert_eq!(
            reduce_black_levels(&[10.0, 20.0], 1, 2, 1, CfaPattern::Rggb, (0, 0)),
            [15; 4]
        );
    }
}

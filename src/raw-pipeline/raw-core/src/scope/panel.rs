//! Four-up panel reduction of the bounded display RGB8 snapshot (#3885).
//! Matches Apple ScopePanelSample: 64 histogram bins and 64 column means.
//! These waveform/parade values are means, not a density plot or histogram.

use super::SCOPE_SNAPSHOT_MAX_DIM;

pub const PANEL_COLUMNS: usize = 64;
pub const PANEL_VALUES: usize = PANEL_COLUMNS * 7;

/// Channel-major histogram R/G/B counts, then waveform luma and parade R/G/B
/// means (0..1), each block of 64 values. Empty input produces zero plots.
/// Reject malformed/oversized snapshots before touching the output.
pub fn reduce_panel(
    rgb: &[u8],
    width: u32,
    height: u32,
    out: &mut [f64; PANEL_VALUES],
) -> Result<(), &'static str> {
    if width > SCOPE_SNAPSHOT_MAX_DIM || height > SCOPE_SNAPSHOT_MAX_DIM {
        return Err("scope snapshot exceeds 512 pixels on an axis");
    }
    let required = width as usize * height as usize * 3;
    if rgb.len() != required {
        return Err("scope snapshot byte count does not match dimensions");
    }
    out.fill(0.0);
    if required == 0 {
        return Ok(());
    }
    let mut count = [0u32; PANEL_COLUMNS];
    let mut sums = [[0u32; PANEL_COLUMNS]; 3];
    let mut column_of = [0usize; SCOPE_SNAPSHOT_MAX_DIM as usize];
    for x in 0..width as usize {
        column_of[x] = x * PANEL_COLUMNS / width as usize;
    }
    for row in rgb.chunks_exact(width as usize * 3) {
        for (x, pixel) in row.chunks_exact(3).enumerate() {
            let column = column_of[x];
            count[column] += 1;
            for channel in 0..3 {
                let value = pixel[channel] as usize;
                out[channel * PANEL_COLUMNS + value * PANEL_COLUMNS / 256] += 1.0;
                sums[channel][column] += value as u32;
            }
        }
    }
    for column in 0..PANEL_COLUMNS {
        if count[column] == 0 {
            continue;
        }
        let mean = |channel: usize| sums[channel][column] as f64 / (count[column] as f64 * 255.0);
        let (r, g, b) = (mean(0), mean(1), mean(2));
        out[3 * PANEL_COLUMNS + column] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        out[4 * PANEL_COLUMNS + column] = r;
        out[5 * PANEL_COLUMNS + column] = g;
        out[6 * PANEL_COLUMNS + column] = b;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primary_columns_have_known_luma_and_independent_histograms() {
        let rgb = [255, 0, 0, 0, 255, 0, 0, 0, 255];
        let mut out = [0.0; PANEL_VALUES];
        reduce_panel(&rgb, 3, 1, &mut out).unwrap();
        for channel in 0..3 {
            assert_eq!(out[channel * 64], 2.0);
            assert_eq!(out[channel * 64 + 63], 1.0);
            assert_eq!(
                out[channel * 64..(channel + 1) * 64].iter().sum::<f64>(),
                3.0
            );
        }
        for (column, luma) in [(0, 0.2126), (21, 0.7152), (42, 0.0722)] {
            assert!((out[192 + column] - luma).abs() < 1e-12);
        }
        assert_eq!(out[256], 1.0);
        assert_eq!(out[320 + 21], 1.0);
        assert_eq!(out[384 + 42], 1.0);
        assert_eq!(out[193], 0.0, "unoccupied columns stay finite zero");
    }

    #[test]
    fn vertical_black_white_pairs_average_without_losing_histogram_extremes() {
        let mut rgb = vec![0; 64 * 2 * 3];
        rgb[64 * 3..].fill(255);
        let mut out = [0.0; PANEL_VALUES];
        reduce_panel(&rgb, 64, 2, &mut out).unwrap();
        for channel in 0..3 {
            assert_eq!(out[channel * 64], 64.0);
            assert_eq!(out[channel * 64 + 63], 64.0);
        }
        for value in &out[192..] {
            assert!((*value - 0.5).abs() < 1e-12);
        }
    }

    #[test]
    fn uneven_width_buckets_match_an_independent_column_oracle() {
        let (width, height) = (137usize, 5usize);
        let rgb: Vec<u8> = (0..width * height)
            .flat_map(|p| [(p % 256) as u8, 64, 192])
            .collect();
        let mut out = [0.0; PANEL_VALUES];
        reduce_panel(&rgb, width as u32, height as u32, &mut out).unwrap();
        for column in 0..64 {
            let pixels: Vec<_> = (0..width * height)
                .filter(|p| (p % width) * 64 / width == column)
                .collect();
            let sum: usize = pixels.iter().map(|p| rgb[p * 3] as usize).sum();
            assert!((out[256 + column] - sum as f64 / (pixels.len() * 255) as f64).abs() < 1e-12);
            assert!((out[320 + column] - 64.0 / 255.0).abs() < 1e-12);
        }
    }

    #[test]
    fn invalid_input_is_atomic_and_empty_input_clears_previous_plots() {
        let mut out = [7.0; PANEL_VALUES];
        for (rgb, w, h) in [
            (&[0u8][..], 1, 1),
            (&[][..], 513, 1),
            (&[][..], u32::MAX, u32::MAX),
        ] {
            assert!(reduce_panel(rgb, w, h, &mut out).is_err());
            assert_eq!(out, [7.0; PANEL_VALUES]);
        }
        reduce_panel(&[], 0, 0, &mut out).unwrap();
        assert_eq!(out, [0.0; PANEL_VALUES]);
    }
}

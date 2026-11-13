//! Display-encoded waveform/parade distributions, preserving clipping within each column.
use super::{panel::PANEL_COLUMNS, SCOPE_SNAPSHOT_MAX_DIM};

pub const DENSITY_BINS: usize = 64;
pub const DENSITY_PLANE: usize = PANEL_COLUMNS * DENSITY_BINS;

/// Four column-major count planes: Rec.709 encoded luma, then R/G/B.
/// No averaging: black and white in one column remain two distinct traces.
pub fn reduce_density(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u32>, &'static str> {
    if width > SCOPE_SNAPSHOT_MAX_DIM || height > SCOPE_SNAPSHOT_MAX_DIM {
        return Err("scope snapshot exceeds 512 pixels on an axis");
    }
    if rgb.len() != width as usize * height as usize * 3 {
        return Err("scope snapshot byte count does not match dimensions");
    }
    let mut counts = vec![0; 4 * DENSITY_PLANE];
    if width == 0 || height == 0 {
        return Ok(counts);
    }
    for (index, pixel) in rgb.chunks_exact(3).enumerate() {
        let column = (index % width as usize) * PANEL_COLUMNS / width as usize;
        let luma = 0.2126 * pixel[0] as f64 + 0.7152 * pixel[1] as f64 + 0.0722 * pixel[2] as f64;
        let values = [luma, pixel[0] as f64, pixel[1] as f64, pixel[2] as f64];
        for (plane, value) in values.into_iter().enumerate() {
            let bin = ((value * DENSITY_BINS as f64 / 256.0) as usize).min(DENSITY_BINS - 1);
            counts[plane * DENSITY_PLANE + column * DENSITY_BINS + bin] += 1;
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equal_column_means_keep_different_distributions_and_clipping() {
        let mut old_split = [0.0; super::super::panel::PANEL_VALUES];
        let mut old_middle = old_split;
        super::super::panel::reduce_panel(&[0, 0, 0, 255, 255, 255], 1, 2, &mut old_split).unwrap();
        super::super::panel::reduce_panel(&[127, 127, 127, 128, 128, 128], 1, 2, &mut old_middle)
            .unwrap();
        assert_eq!(
            &old_split[3 * PANEL_COLUMNS..],
            &old_middle[3 * PANEL_COLUMNS..]
        );
        let split = reduce_density(&[0, 0, 0, 255, 255, 255], 1, 2).unwrap();
        let middle = reduce_density(&[127, 127, 127, 128, 128, 128], 1, 2).unwrap();
        for plane in 0..4 {
            let base = plane * DENSITY_PLANE;
            assert_eq!((split[base], split[base + 63]), (1, 1));
            assert_eq!((middle[base], middle[base + 63]), (0, 0));
            assert_eq!(split[base..base + DENSITY_PLANE].iter().sum::<u32>(), 2);
        }
    }
    #[test]
    fn malformed_input_fails_before_allocation_and_empty_is_finite_zero() {
        assert!(reduce_density(&[], u32::MAX, 2).is_err());
        assert!(reduce_density(&[0], 1, 1).is_err());
        assert_eq!(
            reduce_density(&[], 0, 0).unwrap(),
            vec![0; 4 * DENSITY_PLANE]
        );
    }
}

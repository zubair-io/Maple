//! Bounded agent scope evidence (#4104), reduced from the same display-encoded
//! RGB and canonical mask weights. Counts are qualifying pixels, not histogram
//! fixed-point mass. Skin identification is a caller's explicit target contract.
use super::{cb_cr_rec709, SCOPE_SNAPSHOT_MAX_DIM};

pub const MIN_CHROMATIC_SAMPLES: u32 = 50;
pub const SKIN_LINE_DEG: f64 = 123.0;
pub const SKIN_WEDGE_DEG: f64 = 10.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ScopeEvidence {
    pub sample_count: u32,
    pub mean_cb: f64,
    pub mean_cr: f64,
    pub angle_deg: f64,
    pub deviation_deg: f64,
    pub resultant_length: f64,
    /// 0 insufficient, 1 low, 2 moderate, 3 high.
    pub confidence: u32,
}

/// RGBA8 in encoded sRGB. Alpha is canonical coverage only when `weighted`;
/// malformed buffers fail closed, including an empty or oversized snapshot.
pub fn reduce_scope_evidence(
    rgba: &[u8],
    width: u32,
    height: u32,
    weighted: bool,
) -> Result<ScopeEvidence, &'static str> {
    if width == 0
        || height == 0
        || width > SCOPE_SNAPSHOT_MAX_DIM
        || height > SCOPE_SNAPSHOT_MAX_DIM
        || rgba.len() as u64 != u64::from(width) * u64::from(height) * 4
    {
        return Err("invalid bounded scope pixels or weights");
    }
    let mut result = ScopeEvidence::default();
    let (mut cb_sum, mut cr_sum, mut weight_sum, mut unit_x, mut unit_y) =
        (0.0, 0.0, 0.0, 0.0, 0.0);
    for pixel in rgba.chunks_exact(4) {
        if weighted && pixel[3] < 12 {
            continue;
        }
        let weight = if weighted {
            f64::from(pixel[3]) / 255.0
        } else {
            1.0
        };
        let (cb, cr) = cb_cr_rec709([
            f32::from(pixel[0]) / 255.0,
            f32::from(pixel[1]) / 255.0,
            f32::from(pixel[2]) / 255.0,
        ]);
        let (cb, cr) = (f64::from(cb), f64::from(cr));
        let magnitude = cb.hypot(cr);
        if magnitude < 0.008 {
            continue;
        }
        result.sample_count += 1;
        cb_sum += cb * weight;
        cr_sum += cr * weight;
        weight_sum += weight;
        unit_x += cb / magnitude * weight;
        unit_y += cr / magnitude * weight;
    }
    if weight_sum > 0.0 {
        result.mean_cb = (cb_sum / weight_sum * 10_000.0).round() / 10_000.0;
        result.mean_cr = (cr_sum / weight_sum * 10_000.0).round() / 10_000.0;
        result.resultant_length = unit_x.hypot(unit_y) / weight_sum;
    }
    if result.sample_count < MIN_CHROMATIC_SAMPLES || weight_sum <= 0.0 {
        return Ok(result);
    }
    result.angle_deg = (unit_y.atan2(unit_x).to_degrees().rem_euclid(360.0) * 10.0).round() / 10.0;
    result.deviation_deg =
        ((result.angle_deg - SKIN_LINE_DEG + 180.0).rem_euclid(360.0) - 180.0) * 10.0;
    result.deviation_deg = result.deviation_deg.round() / 10.0;
    result.confidence = if result.sample_count >= 200 && result.resultant_length >= 0.5 {
        3
    } else if result.sample_count >= 100 {
        2
    } else {
        1
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evidence_thresholds_are_raw_sample_counts_not_mask_mass() {
        for (count, confidence) in [(49, 0), (50, 1), (99, 1), (100, 2), (199, 2), (200, 3)] {
            let pixels = [200, 145, 115, 12].repeat(count);
            let evidence = reduce_scope_evidence(&pixels, count as u32, 1, true).unwrap();
            assert_eq!(evidence.sample_count, count as u32);
            assert_eq!(evidence.confidence, confidence);
            assert!((115.0..130.0).contains(&evidence.angle_deg) || confidence == 0);
        }
    }
    #[test]
    fn weak_coverage_and_neutral_pixels_never_create_evidence() {
        assert_eq!(
            reduce_scope_evidence(&[200, 145, 115, 11].repeat(200), 200, 1, true)
                .unwrap()
                .sample_count,
            0
        );
        assert_eq!(
            reduce_scope_evidence(&[128, 128, 128, 255].repeat(200), 200, 1, false)
                .unwrap()
                .sample_count,
            0
        );
        assert_eq!(
            reduce_scope_evidence(&[200, 145, 115, 0].repeat(200), 200, 1, false)
                .unwrap()
                .confidence,
            3
        );
    }
    #[test]
    fn opposed_chroma_does_not_claim_high_concentration() {
        let pixels: Vec<_> = [255, 0, 0, 255]
            .repeat(100)
            .into_iter()
            .chain([0, 255, 255, 255].repeat(100))
            .collect();
        let evidence = reduce_scope_evidence(&pixels, 200, 1, false).unwrap();
        assert_eq!(evidence.confidence, 2);
        assert!(evidence.resultant_length < 0.001);
    }
    #[test]
    fn malformed_weights_and_dimensions_fail_closed() {
        for (pixels, w, h) in [
            (&[0u8; 3][..], 1, 1),
            (&[][..], 0, 0),
            (&[][..], u32::MAX, u32::MAX),
        ] {
            assert!(reduce_scope_evidence(pixels, w, h, true).is_err());
        }
    }
}

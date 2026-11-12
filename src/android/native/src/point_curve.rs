//! Point tone-curve plot samples from raw-core's own evaluator.
use raw_core::{stages::tone_curves::point_curve_preview, types::adjustment::ToneCurve};
use std::slice;

/// Writes `samples + 1` curve outputs at `x = i / samples` into `out` for the
/// `pairs` interleaved `[x, y]` knots in `points`. Returns false (with the
/// thread error set) for invalid buffers.
#[no_mangle]
pub unsafe extern "C" fn maple_android_point_curve(
    points: *const f32,
    pairs: usize,
    samples: usize,
    out: *mut f32,
) -> bool {
    crate::guarded(false, || {
        if (pairs > 0 && points.is_null()) || out.is_null() || samples == 0 || pairs > 256 {
            return Err("Invalid tone curve preview request".into());
        }
        let knots = if pairs == 0 {
            &[][..]
        } else {
            slice::from_raw_parts(points, pairs * 2)
        };
        let curve = ToneCurve::new(
            knots
                .chunks_exact(2)
                .map(|knot| (knot[0], knot[1]))
                .collect(),
        );
        let output = slice::from_raw_parts_mut(out, samples + 1);
        for (slot, (_, y)) in output.iter_mut().zip(point_curve_preview(&curve, samples)) {
            *slot = y;
        }
        Ok(true)
    })
}

#[cfg(test)]
mod tests {
    use super::maple_android_point_curve;

    fn preview(points: &[f32], samples: usize) -> Vec<f32> {
        let mut out = vec![f32::NAN; samples + 1];
        assert!(unsafe {
            maple_android_point_curve(points.as_ptr(), points.len() / 2, samples, out.as_mut_ptr())
        });
        out
    }

    #[test]
    fn samples_the_cross_platform_parity_anchor() {
        // raw-core's PARITY_KNOTS / PARITY_SAMPLES (#367), shared with Apple and Web.
        let knots = [0.0, 0.0, 0.25, 0.15, 0.6, 0.72, 1.0, 1.0];
        let expected = [
            0.0, 0.047657, 0.103543, 0.215379, 0.386152, 0.570335, 0.72, 0.816116, 0.883214,
            0.938705, 1.0,
        ];
        for (got, want) in preview(&knots, 10).iter().zip(expected) {
            assert!((got - want).abs() < 1e-5, "expected {want}, got {got}");
        }
    }

    #[test]
    fn empty_curve_is_identity_and_bad_buffers_fail() {
        assert_eq!(preview(&[], 4), vec![0.0, 0.25, 0.5, 0.75, 1.0]);
        let mut out = [0.0f32; 2];
        assert!(!unsafe { maple_android_point_curve(std::ptr::null(), 1, 1, out.as_mut_ptr()) });
        assert!(!unsafe { maple_android_point_curve(std::ptr::null(), 0, 0, out.as_mut_ptr()) });
    }
}

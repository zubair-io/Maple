use super::*;
use raw_core::view::auto_profile::{lut::ColorLut, ProfileCurve};

#[test]
fn live_frames_borrow_large_host_artifacts_without_copying() {
    let curve = ProfileCurve::identity().to_flat();
    let residual = ColorLut::identity(49);
    let film = ColorLut::identity(33);
    // The C caller commonly starts from a zero-initialized parameter block.
    let mut params: MapleGpuLiveParams = unsafe { std::mem::zeroed() };
    params.temperature = 6500.0;
    params.profile_curve_ptr = curve.as_ptr();
    params.profile_curve_len = curve.len();
    params.residual_lut_ptr = residual.data.as_ptr();
    params.residual_lut_len = residual.data.len();
    params.residual_lut_size = residual.size as u32;
    params.film_lut_ptr = film.data.as_ptr();
    params.film_lut_len = film.data.len();
    params.film_lut_size = film.size as u32;

    for exposure in 0..40 {
        params.exposure = exposure as f32 / 10.0;
        let inputs = unsafe { inputs_from_params(&params) };
        assert!(matches!(inputs.profile_curve_flat, Cow::Borrowed(_)));
        assert!(matches!(inputs.residual_lut_data, Cow::Borrowed(_)));
        assert!(matches!(inputs.film_lut_data, Cow::Borrowed(_)));
        assert_eq!(inputs.profile_curve_flat.as_ptr(), curve.as_ptr());
        assert_eq!(inputs.residual_lut_data.as_ptr(), residual.data.as_ptr());
        assert_eq!(inputs.film_lut_data.as_ptr(), film.data.as_ptr());
        assert_eq!(inputs.tone[0], params.exposure);
    }
}

#[test]
fn absent_or_malformed_artifacts_signal_absence_without_allocating() {
    let mut params: MapleGpuLiveParams = unsafe { std::mem::zeroed() };
    // Zeroed params (the Neutral host path): empty curve + size-0 LUT, both
    // borrowed — the composers omit the look passes (raw-core's `if let Some`
    // skips). Never a substituted identity: the curve knee is not a no-op.
    let empty_curve = unsafe { curve_flat_or_empty(&params) };
    assert!(empty_curve.is_empty());
    assert!(matches!(empty_curve, Cow::Borrowed(_)));
    let (size, empty_lut) = unsafe { residual_or_empty(&params) };
    assert_eq!(size, 0);
    assert!(empty_lut.is_empty());
    assert!(matches!(empty_lut, Cow::Borrowed(_)));

    // A partial/stale caller can supply an edge without its array. Size must
    // fall back alongside the array, rather than presenting a mismatched grid.
    params.residual_lut_size = 49;
    let (size, second_lut) = unsafe { residual_or_empty(&params) };
    assert_eq!(size, 0);
    assert!(second_lut.is_empty());
    let second_curve = unsafe { curve_flat_or_empty(&params) };
    assert!(second_curve.is_empty());
    assert!(matches!(second_curve, Cow::Borrowed(_)));
    assert!(matches!(second_lut, Cow::Borrowed(_)));
    drop(second_lut);

    let malformed_curve = [0.5f32; 10];
    params.profile_curve_ptr = malformed_curve.as_ptr();
    params.profile_curve_len = malformed_curve.len();
    assert!(unsafe { curve_flat_or_empty(&params) }.is_empty());
    let truncated = [0.5f32; 3];
    params.residual_lut_ptr = truncated.as_ptr();
    params.residual_lut_len = truncated.len();
    params.film_lut_ptr = truncated.as_ptr();
    params.film_lut_len = truncated.len();
    params.film_lut_size = 33;
    assert_eq!(unsafe { residual_or_empty(&params) }.0, 0);
    assert_eq!(unsafe { film_lut_or_off(&params) }.0, 0);
}

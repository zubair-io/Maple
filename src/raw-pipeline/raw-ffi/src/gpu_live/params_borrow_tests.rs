use super::*;
use raw_core::view::auto_profile::{lut::ColorLut, ProfileCurve};

#[test]
fn live_frames_borrow_large_host_artifacts_without_copying() {
    let color_points = [0.1, 0.7, 0.7, 0.3];
    let curve = ProfileCurve::identity().to_flat();
    let residual = ColorLut::identity(49);
    let film = ColorLut::identity(33);
    // The C caller commonly starts from a zero-initialized parameter block.
    let mut params: MapleGpuLiveParams = unsafe { std::mem::zeroed() };
    params.temperature = 6500.0;
    params.color_curve_hue_vs_hue_ptr = color_points.as_ptr();
    params.color_curve_hue_vs_hue_len = color_points.len();
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
        let inputs = unsafe { inputs_from_params(&params) }.unwrap();
        assert!(matches!(&inputs.color_curves.hue_vs_hue,
            raw_gpu::ColorCurvePoints::Flat(points) if points.as_ptr() == color_points.as_ptr()));
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

#[test]
fn deriving_a_tick_creative_plan_allocates_nothing_and_borrows_the_tables() {
    use raw_core::test_support::creative::{creative_stage, Tables};
    let stage = creative_stage(Tables::DualHueSatMapAndLook, 1.2);
    let (header, wire) = stage
        .transport(raw_core::xmp::HighlightRecoveryMode::OklabChromaReduction)
        .unwrap();
    let tables = crate::wb_frame_flat::intern_table_wire(wire.floats());
    let creative = crate::capture_creative::MapleCaptureCreative::new(&header, tables);
    let mut params: MapleGpuLiveParams = unsafe { std::mem::zeroed() };
    params.creative_ptr = &creative;
    for temperature in [2000.0, 3300.0, 5200.0, 9000.0, 50000.0] {
        params.temperature = temperature;
        params.tint = 7.0;
        let mut plan = None;
        let allocations = crate::allocation_counter::count(|| {
            let tick = raw_core::pipeline::CreativeTick {
                temperature: params.temperature,
                tint: params.tint,
                wb_method: raw_core::types::WbMethod::Cat16,
            };
            plan = unsafe { crate::capture_creative::gpu_plan(params.creative_ptr, tick) }.unwrap();
        });
        assert_eq!(allocations, 0, "T={temperature}");
        assert_eq!(plan.unwrap().tables.as_ptr(), tables.as_ptr());
    }
    let inputs = unsafe { inputs_from_params(&params) }.unwrap();
    assert!(inputs.creative.is_some());
    let absent = crate::capture_creative::MapleCaptureCreative::ABSENT;
    params.creative_ptr = &absent;
    assert!(unsafe { inputs_from_params(&params) }.is_err());
}

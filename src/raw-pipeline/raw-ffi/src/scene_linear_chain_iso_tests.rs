//! Noise-model ISO the CPU FFI chain hands to raw-core (#4653): a RAW host
//! that leaves ISO 0 keeps the legacy default of 100, while a developed raster
//! has no sensor ISO and stays unknown (0), as on the GPU-live chain
//! (`gpu_live/params_iso_tests.rs`), so the same raster and sliders select the
//! same NLM normalisation on both.

use crate::scene_linear_chain::chain_inputs_from_params;
use crate::scene_linear_chain_tests::default_params;
use crate::MapleAdjustmentParams;

fn chain_iso(skip_agx: u32, iso: u32) -> u32 {
    let p = MapleAdjustmentParams {
        skip_agx,
        iso,
        ..default_params()
    };
    unsafe { chain_inputs_from_params(&p) }.unwrap().iso
}

#[test]
fn a_raw_host_that_leaves_iso_zero_keeps_the_legacy_default() {
    assert_eq!(chain_iso(0, 0), 100);
}

#[test]
fn a_raster_without_sensor_iso_stays_unknown() {
    assert_eq!(chain_iso(1, 0), 0);
}

#[test]
fn a_host_supplied_iso_passes_through_for_raw_and_raster() {
    for iso in [100, 1600, 12_800] {
        assert_eq!(chain_iso(0, iso), iso);
        assert_eq!(chain_iso(1, iso), iso);
    }
}

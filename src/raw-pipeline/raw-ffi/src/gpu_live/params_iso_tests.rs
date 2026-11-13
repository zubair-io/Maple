use super::*;

fn live_iso(input_shape: u32, iso: u32) -> u32 {
    let mut params: MapleGpuLiveParams = unsafe { std::mem::zeroed() };
    params.input_shape = input_shape;
    params.iso = iso;
    unsafe { inputs_from_params(&params) }.unwrap().iso
}

#[test]
fn a_raw_host_that_leaves_iso_zero_keeps_the_legacy_default() {
    assert_eq!(live_iso(0, 0), 100);
}

#[test]
fn a_raster_without_sensor_iso_stays_unknown() {
    assert_eq!(live_iso(1, 0), 0);
    assert_eq!(live_iso(2, 0), 0);
}

#[test]
fn a_host_supplied_iso_passes_through_for_raw_and_raster() {
    for iso in [100, 1600, 12_800] {
        assert_eq!(live_iso(0, iso), iso);
        assert_eq!(live_iso(1, iso), iso);
    }
}

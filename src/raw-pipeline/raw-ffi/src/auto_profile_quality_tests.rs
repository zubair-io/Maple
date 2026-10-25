//! #5158: the fit entries honour the whole develop quality wire enum. A fit is
//! seeded under ONE quality's cache key on an undecodable file, so rc 0 is only
//! possible for the wire value that maps to that quality; every other value
//! must miss, fall through to the decode and fail it (rc 7).

use super::quality_from_wire;
use raw_core::pipeline::RenderQuality;
use raw_core::view::auto_profile::apply_pipeline::auto1_enabled_by_env;
#[cfg(feature = "gpu")]
use raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN;
use raw_core::view::auto_profile::{bake_auto_profile_lut, cache, lut::ColorLut, ProfileCurve};

const WIRE_QUALITIES: [(i32, RenderQuality); 4] = [
    (0, RenderQuality::Full),
    (1, RenderQuality::Preview),
    (2, RenderQuality::Amaze),
    (3, RenderQuality::Auto),
];

const CUBE_N: usize = 9;

#[test]
fn wire_values_map_to_the_render_abi_qualities() {
    for (wire, quality) in WIRE_QUALITIES {
        assert_eq!(quality_from_wire(wire), quality, "wire={wire}");
    }
    assert_eq!(quality_from_wire(-1), RenderQuality::Full);
    assert_eq!(quality_from_wire(4), RenderQuality::Full);
}

struct SeededFile {
    _directory: tempfile::TempDir,
    cpath: std::ffi::CString,
    residual: ColorLut,
}

fn seed_only(quality: RenderQuality, gamma: f32) -> SeededFile {
    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .join(format!("quality-{quality:?}-5158.dng"));
    std::fs::write(&path, b"not a decodable RAW").unwrap();
    let identity = ColorLut::identity(5);
    let residual = ColorLut {
        size: identity.size,
        data: identity.data.iter().map(|v| v.powf(gamma)).collect(),
    };
    let key = cache::CacheKey::from_path(&path, quality).expect("temp file is stattable");
    cache::insert(key.clone(), ProfileCurve::identity());
    cache::insert_lut(key, residual.clone());
    SeededFile {
        cpath: std::ffi::CString::new(path.to_str().unwrap()).unwrap(),
        _directory: directory,
        residual,
    }
}

// The cached identity curve is the Auto 2 marker: it is surfaced only under the
// Auto 1 escape hatch, otherwise the residual alone forms the tail.
fn expected_cube(residual: &ColorLut) -> Vec<f32> {
    if auto1_enabled_by_env() {
        return bake_auto_profile_lut(&ProfileCurve::identity(), residual, CUBE_N);
    }
    let mut cube = ColorLut::identity(CUBE_N).data;
    residual.apply(&mut cube);
    cube
}

fn cube(file: &SeededFile, wire: i32) -> (i32, Vec<f32>) {
    let mut output = vec![f32::NAN; CUBE_N * CUBE_N * CUBE_N * 3];
    let rc = unsafe {
        super::maple_compute_auto_profile_lut(
            file.cpath.as_ptr(),
            std::ptr::null(),
            wire,
            CUBE_N as u32,
            output.as_mut_ptr(),
        )
    };
    (rc, output)
}

#[test]
fn cube_serves_a_cached_fit_only_to_its_own_wire_quality() {
    for (seeded_wire, quality) in WIRE_QUALITIES {
        let file = seed_only(quality, 1.1);
        for (wire, _) in WIRE_QUALITIES {
            let (rc, output) = cube(&file, wire);
            if wire == seeded_wire {
                assert_eq!(rc, 0, "wire={wire}: must hit the {quality:?} fit");
                assert_eq!(output, expected_cube(&file.residual), "wire={wire}");
            } else {
                assert_eq!(
                    rc, 7,
                    "wire={wire}: must miss the {quality:?} fit and fail the decode"
                );
            }
        }
    }
}

#[cfg(feature = "gpu")]
fn separate_artifacts(file: &SeededFile, wire: i32) -> (i32, i32, u32, Vec<f32>) {
    let mut output_curve = [f32::NAN; PROFILE_CURVE_FLAT_LEN];
    let mut present = 0;
    let mut size = 0;
    let mut output_lut = vec![f32::NAN; file.residual.data.len()];
    let rc = unsafe {
        crate::gpu_auto_profile::maple_gpu_fit_auto_profile(
            file.cpath.as_ptr(),
            std::ptr::null(),
            wire,
            output_curve.as_mut_ptr(),
            &mut present,
            output_lut.as_mut_ptr(),
            output_lut.len(),
            &mut size,
        )
    };
    (rc, present, size, output_lut)
}

#[cfg(feature = "gpu")]
#[test]
fn separate_artifacts_serve_a_cached_fit_only_to_its_own_wire_quality() {
    for (seeded_wire, quality) in WIRE_QUALITIES {
        let file = seed_only(quality, 1.3);
        for (wire, _) in WIRE_QUALITIES {
            let (rc, present, size, output_lut) = separate_artifacts(&file, wire);
            if wire == seeded_wire {
                assert_eq!(rc, 0, "wire={wire}: must hit the {quality:?} fit");
                assert_eq!(present, i32::from(auto1_enabled_by_env()), "wire={wire}");
                assert_eq!(size, file.residual.size as u32, "wire={wire}");
                assert_eq!(output_lut, file.residual.data, "wire={wire}");
            } else {
                assert_eq!(
                    rc, 7,
                    "wire={wire}: must miss the {quality:?} fit and fail the decode"
                );
            }
        }
    }
}

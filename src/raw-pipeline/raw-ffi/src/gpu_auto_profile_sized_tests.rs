use super::*;
use raw_core::pipeline::RenderQuality;
use raw_core::view::auto_profile::{lut::ColorLut, ProfileCurve};
use std::{ffi::CString, path::Path, ptr};

struct Artifacts {
    curve: [f32; MAPLE_PROFILE_CURVE_FLAT_LEN],
    present: i32,
    lut: Vec<f32>,
    size: u32,
}

impl Artifacts {
    fn new() -> Self {
        Self {
            curve: [0.; MAPLE_PROFILE_CURVE_FLAT_LEN],
            present: -1,
            lut: vec![0.; 49 * 49 * 49 * 3],
            size: 999,
        }
    }

    unsafe fn call(&mut self, raw: &CString, xmp: *const c_char, edge: u32) -> i32 {
        maple_gpu_fit_auto_profile_at_render_size(
            raw.as_ptr(),
            xmp,
            1,
            edge,
            self.curve.as_mut_ptr(),
            &mut self.present,
            self.lut.as_mut_ptr(),
            self.lut.len(),
            &mut self.size,
        )
    }

    fn pair(&self) -> (Option<ProfileCurve>, Option<ColorLut>) {
        let curve = (self.present == 1).then(|| ProfileCurve::from_flat(&self.curve).unwrap());
        let size = self.size as usize;
        let lut = (size > 0).then(|| ColorLut {
            size,
            data: self.lut[..size * size * size * 3].to_vec(),
        });
        (curve, lut)
    }
}

#[test]
fn sized_ffi_rejects_zero_edge_and_preserves_buffers() {
    let raw = CString::new("absent.dng").unwrap();
    let mut artifacts = Artifacts::new();
    assert_eq!(unsafe { artifacts.call(&raw, ptr::null(), 0) }, -1);
    assert_eq!(artifacts.present, -1);
    assert_eq!(artifacts.size, 999);
    assert!(artifacts
        .curve
        .iter()
        .chain(&artifacts.lut)
        .all(|v| *v == 0.));
}

#[test]
fn sized_ffi_reports_missing_raw_and_initializes_presence() {
    let directory = tempfile::tempdir().unwrap();
    let raw = CString::new(directory.path().join("absent.dng").to_str().unwrap()).unwrap();
    let mut artifacts = Artifacts::new();
    assert_eq!(unsafe { artifacts.call(&raw, ptr::null(), 1600) }, 6);
    assert_eq!((artifacts.present, artifacts.size), (0, 0));
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn sized_ffi_matches_core_with_cold_warm_and_edited_callers() {
    let source = std::env::var_os("MAPLE_RENDER_FIT_TEST_RAW")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws/test_0017.dng")
        });
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("owned.dng");
    std::fs::copy(source, &path).expect("real RAW required with fixtures feature");
    let raw_path = CString::new(path.to_str().unwrap()).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let raw = decode_bytes(&bytes, "dng").unwrap();
    let default_model = raw_core::xmp::AdjustmentModel::default();
    let mut edited = default_model.clone();
    edited.exposure = 2.;
    edited.temperature = 4200.;
    edited.contrast = 40.;
    let sidecar = directory.path().join("edited.xmp");
    std::fs::write(&sidecar, raw_core::xmp::serialize(&edited)).unwrap();
    let sidecar = CString::new(sidecar.to_str().unwrap()).unwrap();
    let standalone = raw_core::pipeline::fit_auto_profile_from_raw(
        &raw,
        &default_model,
        RenderQuality::Preview,
        RawInput::Path(&path),
    )
    .expect("embedded preview required");
    let mut previous = None;
    for edge in [1600, 4096] {
        let mut actual = Artifacts::new();
        assert_eq!(unsafe { actual.call(&raw_path, sidecar.as_ptr(), edge) }, 0);
        assert!(
            actual.present == 1 && actual.size > 0,
            "both real stages required"
        );
        let pair = actual.pair();
        let expected = fit_auto_profile_from_raw_at_cap(
            &raw,
            &default_model,
            RenderQuality::Preview,
            RawInput::Path(&path),
            FitCap::Render(edge),
        )
        .unwrap();
        assert_eq!(
            pair, expected,
            "FFI must match the core render-size artifacts"
        );
        assert_ne!(
            pair, standalone,
            "standalone cache cannot satisfy render-size fit"
        );
        if let Some(prior) = previous.take() {
            assert_ne!(pair, prior, "fixture must distinguish the requested caps");
        }
        previous = Some(pair.clone());
        let mut warm = Artifacts::new();
        assert_eq!(unsafe { warm.call(&raw_path, ptr::null(), edge) }, 0);
        assert_eq!(
            pair,
            warm.pair(),
            "warm default caller must match cold edited caller"
        );
        let mut short = Artifacts::new();
        short.lut = vec![-7.; 1];
        assert_eq!(unsafe { short.call(&raw_path, ptr::null(), edge) }, -2);
        assert_eq!(short.size, actual.size);
        assert_eq!(
            short.lut,
            [-7.],
            "undersized residual buffer must not be written"
        );
    }
    assert_eq!(
        std::fs::read(&path).unwrap(),
        bytes,
        "original RAW unchanged"
    );
}

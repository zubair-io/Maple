use super::*;

fn meta() -> FrameMeta {
    let (w, h) = (7, 5);
    let plane = |k: f32| {
        (0..w * h)
            .map(|i| (i as f32 + k) * 0.37e-3)
            .collect::<Vec<_>>()
    };
    FrameMeta {
        proxy: PlanarImage::from_planes(
            w,
            h,
            plane(0.1),
            plane(0.2),
            plane(f32::MIN_POSITIVE),
            ValidityMask::new_filled(w, h, true),
        ),
        proxy_scale_x: 1152.0 / 7.0,
        proxy_scale_y: 864.0 / 5.0,
        full_width: 1152,
        full_height: 864,
        priors: FramePriors {
            focal_mm: Some(6.86),
            focal_35mm_equiv: None,
            focal_px: Some(5866.123_456_789),
            gimbal: Some(GimbalPrior {
                yaw_deg: -12.5,
                pitch_deg: 0.1,
                roll_deg: 1e-9,
            }),
            gps: Some(GpsPrior {
                lat_deg: 51.5,
                lon_deg: -0.12,
                relative_altitude_m: None,
            }),
        },
        camera_make: "Apple".into(),
        camera_model: "iPhone 15 Pro".into(),
        applied_opcodes: vec!["WarpRectilinear".into(), "FixVignetteRadial".into()],
        falloff_correction: FalloffCorrection::Opcode,
    }
}

fn source(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).expect("write source");
    path
}

fn assert_same(got: &FrameMeta, want: &FrameMeta) {
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    assert_eq!(bits(&got.proxy.r), bits(&want.proxy.r));
    assert_eq!(bits(&got.proxy.g), bits(&want.proxy.g));
    assert_eq!(bits(&got.proxy.b), bits(&want.proxy.b));
    assert_eq!(
        (got.proxy.width(), got.proxy.height()),
        (want.proxy.width(), want.proxy.height())
    );
    assert_eq!(got.proxy_scale_x.to_bits(), want.proxy_scale_x.to_bits());
    assert_eq!(got.proxy_scale_y.to_bits(), want.proxy_scale_y.to_bits());
    assert_eq!(
        (got.full_width, got.full_height),
        (want.full_width, want.full_height)
    );
    assert_eq!(got.priors, want.priors);
    assert_eq!(got.camera_make, want.camera_make);
    assert_eq!(got.camera_model, want.camera_model);
    assert_eq!(got.applied_opcodes, want.applied_opcodes);
    assert_eq!(got.falloff_correction, want.falloff_correction);
}

#[test]
fn a_stored_proxy_reads_back_bit_for_bit() {
    let dir = tempfile::tempdir().expect("tempdir");
    let raw = source(dir.path(), "a.dng", b"raw bytes");
    let cache = ProxyCache::new(&dir.path().join("cache"));
    assert!(cache.load(&raw, 1600).is_none());
    cache.store(&raw, 1600, &meta());
    assert_same(&cache.load(&raw, 1600).expect("hit"), &meta());
}

#[test]
fn another_proxy_edge_or_a_changed_source_misses() {
    let dir = tempfile::tempdir().expect("tempdir");
    let raw = source(dir.path(), "a.dng", b"raw bytes");
    let cache = ProxyCache::new(&dir.path().join("cache"));
    cache.store(&raw, 1600, &meta());
    assert!(cache.load(&raw, 1280).is_none());
    std::fs::write(&raw, b"edited raw bytes").expect("rewrite");
    assert!(cache.load(&raw, 1600).is_none());
}

#[test]
fn a_truncated_file_is_a_miss() {
    let dir = tempfile::tempdir().expect("tempdir");
    let raw = source(dir.path(), "a.dng", b"raw bytes");
    let cache = ProxyCache::new(&dir.path().join("cache"));
    cache.store(&raw, 1600, &meta());
    let file = cache.file_for(&raw, 1600);
    let bytes = std::fs::read(&file).expect("cached");
    std::fs::write(&file, &bytes[..bytes.len() - 1]).expect("truncate");
    assert!(cache.load(&raw, 1600).is_none());
}

#[test]
fn retain_only_drops_every_other_frame() {
    let dir = tempfile::tempdir().expect("tempdir");
    let a = source(dir.path(), "a.dng", b"a");
    let b = source(dir.path(), "b.dng", b"b");
    let cache = ProxyCache::new(&dir.path().join("cache"));
    cache.store(&a, 1600, &meta());
    cache.store(&b, 1600, &meta());
    cache.retain_only(std::slice::from_ref(&b), 1600);
    assert!(cache.load(&a, 1600).is_none());
    assert!(cache.load(&b, 1600).is_some());
}

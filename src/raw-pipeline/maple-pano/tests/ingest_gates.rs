//! Fixture-gated ingest gates (#1156).
//!
//! Run against the gitignored DJI pano fixtures at
//! `test-fixtures/raws/pano_01/` (repo root; symlink them in on dev
//! machines). When the fixtures are absent every test skip-passes with a
//! message — mirroring the `test_color_pipeline.sh` "no fixtures,
//! skipping" pattern so CI without RAWs stays green.
//!
//! The full-decode gate runs a 21 MP demosaic; debug-profile runs take
//! tens of seconds. Prefer `cargo test --release -p maple-pano --test
//! ingest_gates` when fixtures are present.

use std::path::PathBuf;

use maple_pano::ingest::{ingest_file, proxy_to_long_edge, FramePriors};

fn pano01_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws/pano_01")
}

fn fixtures_present() -> bool {
    let p = pano01_dir().join("PANO0001.DNG");
    if !p.exists() {
        eprintln!(
            "skip: {} not present (pano fixtures are gitignored)",
            p.display()
        );
        return false;
    }
    true
}

/// Spec §5.1 / ticket gate: decode one pano_01 frame → expected
/// dimensions, finite values, plausible scene-linear range, full
/// validity, correct priors.
#[test]
fn ingest_pano0001_full_frame() {
    if !fixtures_present() {
        return;
    }
    let frame = ingest_file(&pano01_dir().join("PANO0001.DNG")).expect("ingest PANO0001");

    // Identity + dims: DJI Mavic 3 Cine, DefaultCrop 5272×3948 out of the
    // 5376×3956 sensor, EXIF orientation Normal.
    assert_eq!(frame.camera_make, "Hasselblad");
    assert_eq!(frame.camera_model, "L2D-20c");
    let img = &frame.image;
    assert_eq!((img.width(), img.height()), (5272, 3948));
    assert_eq!(img.r.len(), img.pixel_count());

    // Validity: created at decode, all-true (DefaultCrop already dropped
    // the sensor margins).
    assert!(img.validity.all_valid());

    // Finite values + plausible scene-linear range. The frame is a
    // mid-day aerial shot at base ISO: mean must sit well inside (0, 1),
    // maxima may exceed 1.0 (scene-referred, nothing clips) but not
    // explode, and small negatives are legal post-DCP (out-of-gamut
    // sensor noise) but must stay tiny.
    for (label, plane) in [("R", &img.r), ("G", &img.g), ("B", &img.b)] {
        let mut min = f32::INFINITY;
        let mut max = f32::NEG_INFINITY;
        let mut sum = 0.0f64;
        for &v in plane.iter() {
            assert!(v.is_finite(), "{label}: non-finite value {v}");
            min = min.min(v);
            max = max.max(v);
            sum += v as f64;
        }
        let mean = sum / plane.len() as f64;
        assert!(
            mean > 0.001 && mean < 0.9,
            "{label}: implausible scene-linear mean {mean}"
        );
        assert!(min > -0.5, "{label}: implausible minimum {min}");
        assert!(max < 64.0, "{label}: implausible maximum {max}");
        eprintln!("[ingest_gates] {label}: min {min:.5} mean {mean:.5} max {max:.5}");
    }

    // Priors: EXIF focal 12.3 mm / 24 mm-equiv ⇒ focal_px ≈ 3653.6
    // (derivation in ingest::priors module docs); gimbal from the
    // drone-dji packet.
    let p = &frame.priors;
    assert!((p.focal_mm.expect("focal_mm") - 12.3).abs() < 0.05);
    assert!((p.focal_35mm_equiv.expect("f35") - 24.0).abs() < 0.5);
    let fpx = p.focal_px.expect("focal_px");
    assert!((fpx - 3653.6).abs() < 1.0, "focal_px {fpx}");
    let g = p.gimbal.expect("gimbal prior");
    assert!((g.yaw_deg - 87.90).abs() < 1e-9, "yaw {}", g.yaw_deg);
    assert!((g.pitch_deg - -1.30).abs() < 1e-9, "pitch {}", g.pitch_deg);
    assert!((g.roll_deg - 0.0).abs() < 1e-9, "roll {}", g.roll_deg);

    // Proxy: long-edge cap honored with aspect preserved (5272×3948 →
    // 1024×767), validity carried.
    let proxy = proxy_to_long_edge(img, 1024);
    assert_eq!((proxy.width(), proxy.height()), (1024, 767));
    assert!(proxy.validity.all_valid());
}

/// Priors for the full 21-frame set via the metadata-only pass: every
/// frame must yield the EXIF focal pair, the derived pixel focal, and a
/// gimbal prior; yaw must traverse the pano's six-column sweep.
#[test]
fn priors_extracted_for_all_21_frames() {
    if !fixtures_present() {
        return;
    }
    let mut frames: Vec<PathBuf> = std::fs::read_dir(pano01_dir())
        .expect("read pano_01")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("dng"))
        })
        .collect();
    frames.sort();
    assert_eq!(frames.len(), 21, "pano_01 ships 21 frames");

    let mut yaws = Vec::new();
    for path in &frames {
        let bytes = std::fs::read(path).expect("read frame");
        let md = raw_core::read_pano_metadata(&bytes, "dng").expect("metadata");
        let p = FramePriors::from_metadata(&md);
        let name = path.file_name().unwrap().to_string_lossy();

        assert_eq!(md.output_dims, (5272, 3948), "{name}: dims");
        assert!(
            (p.focal_mm.unwrap_or_default() - 12.3).abs() < 0.05,
            "{name}: focal_mm {:?}",
            p.focal_mm
        );
        assert!(
            (p.focal_px.unwrap_or_default() - 3653.6).abs() < 1.0,
            "{name}: focal_px {:?}",
            p.focal_px
        );
        let g = p
            .gimbal
            .unwrap_or_else(|| panic!("{name}: gimbal prior missing"));
        assert!(
            (-180.0..=180.0).contains(&g.yaw_deg),
            "{name}: yaw {}",
            g.yaw_deg
        );
        assert!(
            (-120.0..=120.0).contains(&g.pitch_deg),
            "{name}: pitch {}",
            g.pitch_deg
        );
        assert_eq!(g.roll_deg, 0.0, "{name}: this set was shot roll-locked");
        eprintln!(
            "[ingest_gates] {name}: yaw {:+8.2}  pitch {:+7.2}  roll {:+5.2}",
            g.yaw_deg, g.pitch_deg, g.roll_deg
        );
        yaws.push(g.yaw_deg);
    }

    // The set sweeps a full 360°: six yaw stations ~32° apart. Pin the
    // spread without depending on capture order.
    let (min_yaw, max_yaw) = yaws
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &y| {
            (lo.min(y), hi.max(y))
        });
    assert!(
        max_yaw - min_yaw > 250.0,
        "expected a wide yaw sweep, got [{min_yaw}, {max_yaw}]"
    );
}

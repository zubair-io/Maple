//! Banded vs full-frame byte equality on every committed pano fixture frame
//! (the RAWs are gitignored, so this is `#[ignore]`d and skip-passes without
//! them). Run with
//! `cargo test --release -p raw-core --lib banded::tests_fixtures -- --ignored --nocapture`.

use std::path::PathBuf;

use super::tests::{banded, first_mismatch, full_frame, MemScratch, MemSink};
use super::*;

const BAND_ROWS: [u32; 3] = [512, 1008, 4096];

fn fixture_frames() -> Vec<PathBuf> {
    let Ok(sets) = std::fs::read_dir(crate::test_support::fixtures::raws_root()) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = sets
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("pano_"))
        })
        .collect();
    dirs.sort();
    dirs.iter()
        .flat_map(|dir| {
            let mut frames: Vec<PathBuf> = std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.ok().map(|e| e.path()))
                .filter(|path| {
                    path.extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("dng"))
                })
                .collect();
            frames.sort();
            frames
        })
        .collect()
}

#[test]
#[ignore = "needs the gitignored pano fixtures; run with --release --ignored --nocapture"]
fn banded_matches_decode_for_pano_on_every_pano_fixture_frame() {
    let frames = fixture_frames();
    if frames.is_empty() {
        eprintln!("no pano fixtures, skipping");
        return;
    }
    for path in &frames {
        let bytes = std::fs::read(path).expect("read fixture");
        let want = super::super::decode_for_pano(&bytes, "dng").expect("decode_for_pano");
        let cfa = crate::decode::decode_bytes(&bytes, "dng")
            .expect("decode")
            .cfa;
        let expect_banded = !matches!(cfa, CfaPattern::LinearRgb | CfaPattern::XTrans(_));
        for band_rows in BAND_ROWS {
            let mut sink = MemSink::default();
            let got = develop_banded_for_pano(
                &bytes,
                "dng",
                band_rows,
                &mut MemScratch::default(),
                &mut sink,
            )
            .expect("banded develop");
            assert_eq!(got.banded, expect_banded, "{} ({cfa:?})", path.display());
            assert_eq!(got.applied_opcodes, want.applied_opcodes);
            assert_eq!(got.falloff_correction, want.falloff_correction);
            assert_eq!(got.metadata.output_dims, want.metadata.output_dims);
            assert_eq!(
                first_mismatch(&sink.into_complete(), &want.image),
                None,
                "{} at {band_rows}-row bands",
                path.display()
            );
        }
        eprintln!(
            "{}: bit-identical ({}), opcodes {:?}, falloff {:?}",
            path.display(),
            if expect_banded {
                "banded"
            } else {
                "full-frame fallback"
            },
            want.applied_opcodes,
            want.falloff_correction
        );
    }
}

/// Real sensor data with geometry the fixtures don't carry: each orientation
/// that swaps axes, plus a DefaultCrop and ActiveArea moved off the origin.
#[test]
#[ignore = "needs the gitignored pano fixtures; run with --release --ignored --nocapture"]
fn banded_matches_full_frame_on_fixtures_with_forced_geometry() {
    let frames = fixture_frames();
    if frames.is_empty() {
        eprintln!("no pano fixtures, skipping");
        return;
    }
    let mut first_of_each_set = frames;
    first_of_each_set.dedup_by(|a, b| a.parent() == b.parent());
    for path in &first_of_each_set {
        let bytes = std::fs::read(path).expect("read fixture");
        let base = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let list3 = opcodes::read_opcode_list3(&bytes, "dng", base.width, base.height);
        let (w, h) = (base.width, base.height);
        let crop = CropRect {
            x: 37,
            y: 53,
            w: w - 37 - 91,
            h: h - 53 - 70,
        };
        let area = ActiveAreaRect {
            top: 22,
            left: 14,
            width: w - 14 - 40,
            height: h - 22 - 30,
        };
        let variants = [
            (ExifOrientation::Rotate90, None, None),
            (ExifOrientation::Rotate270, Some(crop), None),
            (ExifOrientation::Transverse, Some(crop), Some(area)),
        ];
        for (orientation, crop_rect, active_area) in variants {
            let raw = RawImage {
                orientation,
                crop_rect: crop_rect.or(base.crop_rect),
                lens_metadata: crate::lens_profile::LensMetadata {
                    active_area: active_area.or(base.lens_metadata.active_area),
                    ..base.lens_metadata.clone()
                },
                ..base.clone()
            };
            let (want, want_applied) = full_frame(&raw, list3.as_ref());
            let (got, developed) = banded(&raw, list3.as_ref(), 1008);
            assert_eq!(developed.applied_opcodes, want_applied);
            assert_eq!(
                first_mismatch(&got, &want),
                None,
                "{} {orientation:?} crop {crop_rect:?} area {active_area:?}",
                path.display()
            );
        }
        eprintln!("{}: forced geometry bit-identical", path.display());
    }
}

/// No pano set carries a lens the bundled database matches, so this finds a
/// Bayer fixture among the colour-test RAWs that does, covering the windowed
/// bundled vignette (#4516) on real data.
#[test]
#[ignore = "needs the gitignored fixtures; run with --release --ignored --nocapture"]
fn banded_matches_decode_for_pano_with_the_bundled_vignette() {
    let Ok(entries) = std::fs::read_dir(crate::test_support::fixtures::raws_root()) else {
        eprintln!("no fixtures, skipping");
        return;
    };
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.is_file())
        .collect();
    candidates.sort();
    let found = candidates.iter().find_map(|path| {
        let ext = path.extension()?.to_string_lossy().to_lowercase();
        let bytes = std::fs::read(path).ok()?;
        let raw = crate::decode::decode_bytes(&bytes, &ext).ok()?;
        let bayer = !matches!(raw.cfa, CfaPattern::LinearRgb | CfaPattern::XTrans(_));
        let matched = crate::lens_profile::resolve_bundled(&raw)
            .ok()
            .flatten()
            .is_some_and(|r| r.calibration.vignette.is_some());
        (bayer && matched).then(|| (path.clone(), bytes, ext))
    });
    let Some((path, bytes, ext)) = found else {
        eprintln!("no Bayer fixture matches a bundled vignette, skipping");
        return;
    };
    let want = super::super::decode_for_pano(&bytes, &ext).expect("decode_for_pano");
    assert_eq!(want.falloff_correction, FalloffCorrection::BundledProfile);
    for band_rows in BAND_ROWS {
        let mut sink = MemSink::default();
        let got = develop_banded_for_pano(
            &bytes,
            &ext,
            band_rows,
            &mut MemScratch::default(),
            &mut sink,
        )
        .expect("banded develop");
        assert!(got.banded);
        assert_eq!(got.falloff_correction, FalloffCorrection::BundledProfile);
        assert_eq!(
            first_mismatch(&sink.into_complete(), &want.image),
            None,
            "{band_rows}-row bands"
        );
    }
    eprintln!("{}: bundled vignette bit-identical", path.display());
}

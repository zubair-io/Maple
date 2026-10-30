use std::path::Path;

use raw_core::test_support::synth_dng::{fix_vignette_radial_opcode_list3, SyntheticGreyDng};
use rayon::prelude::*;

use super::*;

/// A frame with a radial falloff baked in by FixVignetteRadial, so every
/// pixel offset carries a different value and a misplaced row or column
/// shows up.
fn vignetted_dng(width: u32, height: u32, orientation: Option<u16>) -> Vec<u8> {
    SyntheticGreyDng {
        linear_value: 0.3,
        width,
        height,
        orientation,
        opcode_list3: Some(fix_vignette_radial_opcode_list3(
            [-0.4, 0.1, 0.0, 0.0, 0.0],
            0.43,
            0.58,
        )),
        ..SyntheticGreyDng::default()
    }
    .write_to_bytes()
}

fn reference(bytes: &[u8]) -> PlanarImage {
    PlanarImage::from_scene_linear(
        &raw_core::decode_for_pano(bytes, "dng")
            .expect("decode")
            .image,
    )
}

fn store_of(parent: &Path, frames: &[&[u8]]) -> FrameStore {
    let dims: Vec<(u32, u32)> = frames
        .iter()
        .map(|b| reference(b))
        .map(|p| (p.width(), p.height()))
        .collect();
    let mut store = FrameStore::create(parent, &dims).expect("create");
    for (i, bytes) in frames.iter().enumerate() {
        store
            .ingest_bytes(i, bytes, "dng", 16, "synthetic")
            .expect("ingest");
    }
    store
}

fn assert_rows_match(window: &PlanarImage, full: &PlanarImage, y0: u32) {
    let w = full.width() as usize;
    let range = y0 as usize * w..(y0 + window.height()) as usize * w;
    assert_eq!(window.width(), full.width());
    assert_eq!(window.r, full.r[range.clone()]);
    assert_eq!(window.g, full.g[range.clone()]);
    assert_eq!(window.b, full.b[range]);
    assert!(window.validity.all_valid());
}

#[test]
fn stored_frames_read_back_identical_to_decode_for_pano() {
    let parent = tempfile::tempdir().unwrap();
    // 1 = Normal (row bands), 6 and 8 = 90°/270° (full-height column blocks).
    let frames: Vec<Vec<u8>> = [None, Some(6), Some(8)]
        .into_iter()
        .map(|o| vignetted_dng(150, 92, o))
        .collect();
    let refs: Vec<&[u8]> = frames.iter().map(Vec::as_slice).collect();
    let store = store_of(parent.path(), &refs);
    for (i, bytes) in refs.iter().enumerate() {
        let full = reference(bytes);
        let (w, h) = store.dims(i).expect("stored");
        assert_eq!((w, h), (full.width(), full.height()));
        assert_rows_match(&store.read_planar_rows(i, 0, h).unwrap(), &full, 0);
        for (y0, rows) in [(0, 1), (h / 3, 7), (h - 5, 5)] {
            assert_rows_match(&store.read_planar_rows(i, y0, rows).unwrap(), &full, y0);
        }
    }
}

#[test]
fn concurrent_window_reads_agree() {
    let parent = tempfile::tempdir().unwrap();
    let bytes = vignetted_dng(120, 80, Some(6));
    let store = store_of(parent.path(), &[&bytes]);
    let full = reference(&bytes);
    let (_, h) = store.dims(0).unwrap();
    (0..h).into_par_iter().step_by(3).for_each(|y0| {
        let rows = 4.min(h - y0);
        let window = store.read_planar_rows(0, y0, rows).unwrap();
        assert_rows_match(&window, &full, y0);
    });
}

#[test]
fn window_reads_reject_partial_rows_and_overruns() {
    let parent = tempfile::tempdir().unwrap();
    let bytes = vignetted_dng(64, 48, None);
    let store = store_of(parent.path(), &[&bytes]);
    let (w, h) = store.dims(0).unwrap();
    let mut partial = vec![[0.0; 3]; w as usize + 1];
    assert!(store.read_rows(0, 0, &mut partial).is_err());
    let mut overrun = vec![[0.0; 3]; w as usize * 2];
    assert!(store.read_rows(0, h - 1, &mut overrun).is_err());
    assert!(store.read_rows(1, 0, &mut overrun).is_err());
}

#[test]
fn planar_windows_outside_the_frame_are_typed_errors() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_of(dir.path(), &[&vignetted_dng(64, 48, None)]);
    let (_, h) = store.dims(0).unwrap();
    for (y0, rows) in [
        (u32::MAX, 0),
        (u32::MAX, 1),
        (u32::MAX, u32::MAX),
        (1, u32::MAX),
        (0, h + 1),
        (h, 1),
        (h + 1, 0),
    ] {
        assert!(
            matches!(
                store.read_planar_rows(0, y0, rows),
                Err(PanoError::InvalidOptions(_))
            ),
            "rows {y0}+{rows} of a {h}-row frame must be rejected"
        );
    }
    assert_eq!(store.read_planar_rows(0, h, 0).unwrap().height(), 0);
    assert_eq!(store.read_planar_rows(0, 0, h).unwrap().height(), h);
}

#[test]
fn low_disk_fails_the_preflight_with_a_typed_error() {
    let parent = tempfile::tempdir().unwrap();
    let dims = [(1000, 500), (1000, 500)];
    let needed = required_bytes(&dims);
    assert_eq!(needed, (1_000_000 + 500_000 * 9 / 8) * 12);
    let err = FrameStore::create_with(parent.path(), &dims, |_| Ok(needed - 1))
        .err()
        .expect("must refuse");
    match err {
        PanoError::InsufficientScratchSpace {
            path,
            needed: n,
            available,
        } => {
            assert_eq!(path, parent.path());
            assert_eq!((n, available), (needed, needed - 1));
        }
        other => panic!("expected InsufficientScratchSpace, got {other:?}"),
    }
    assert_eq!(
        std::fs::read_dir(parent.path()).unwrap().count(),
        0,
        "nothing written"
    );
    let store =
        FrameStore::create_with(parent.path(), &dims, |_| Ok(needed)).expect("exactly enough");
    assert_eq!(store.needed_bytes, needed);
}

#[test]
fn the_real_volume_reports_free_space() {
    let parent = tempfile::tempdir().unwrap();
    assert!(io::available_bytes(parent.path()).unwrap() > 0);
}

#[test]
fn a_full_volume_mid_write_is_the_typed_error() {
    let parent = tempfile::tempdir().unwrap();
    let store = FrameStore::create(parent.path(), &[(4, 4)]).unwrap();
    let full = raw_core::Error::Io {
        path: store.dir.as_path().join("frame-0000.rgbf32"),
        source: std::io::ErrorKind::StorageFull.into(),
    };
    assert!(matches!(
        store.decode_error("x", full),
        PanoError::InsufficientScratchSpace { needed, .. } if needed == store.needed_bytes
    ));
    let other = raw_core::Error::Io {
        path: store.dir.as_path().into(),
        source: std::io::ErrorKind::PermissionDenied.into(),
    };
    assert!(matches!(
        store.decode_error("x", other),
        PanoError::RawDecode { .. }
    ));
}

#[test]
fn the_directory_is_removed_on_success_failure_and_cancel() {
    let parent = tempfile::tempdir().unwrap();
    let bytes = vignetted_dng(64, 48, None);
    let dims = (reference(&bytes).width(), reference(&bytes).height());
    let leftovers = || std::fs::read_dir(parent.path()).unwrap().count();

    let finished = store_of(parent.path(), &[&bytes]);
    assert!(finished.dir.as_path().join("frame-0000.rgbf32").is_file());
    drop(finished);
    assert_eq!(leftovers(), 0, "success");

    let failed = (|| -> Result<(), PanoError> {
        let mut store = FrameStore::create(parent.path(), &[dims, dims])?;
        store.ingest_bytes(0, &bytes, "dng", 16, "ok")?;
        store.ingest_bytes(1, b"not a raw", "dng", 16, "garbage")?;
        Ok(())
    })();
    assert!(matches!(failed, Err(PanoError::RawDecode { .. })));
    assert_eq!(leftovers(), 0, "failure");

    let cancelled = (|| -> Result<(), PanoError> {
        let mut store = FrameStore::create(parent.path(), &[dims, dims])?;
        store.ingest_bytes(0, &bytes, "dng", 16, "ok")?;
        Err(PanoError::Cancelled)
    })();
    assert!(matches!(cancelled, Err(PanoError::Cancelled)));
    assert_eq!(leftovers(), 0, "cancel");

    let panicked = std::panic::catch_unwind(|| {
        let mut store = FrameStore::create(parent.path(), &[dims]).unwrap();
        store.ingest_bytes(0, &bytes, "dng", 16, "ok").unwrap();
        panic!("stage failed");
    });
    assert!(panicked.is_err());
    assert_eq!(leftovers(), 0, "unwind");
}

#[test]
fn source_bytes_are_only_read() {
    let parent = tempfile::tempdir().unwrap();
    let bytes = vignetted_dng(64, 48, None);
    let source = parent.path().join("source.dng");
    std::fs::write(&source, &bytes).unwrap();
    let dims = (reference(&bytes).width(), reference(&bytes).height());
    let store_parent = parent.path().join("stores");
    std::fs::create_dir(&store_parent).unwrap();
    let mut store = FrameStore::create(&store_parent, &[dims]).unwrap();
    store.ingest_file(0, &source, 16).unwrap();
    drop(store);
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 2);
}

#[test]
fn each_frame_is_stored_once_at_its_planned_size() {
    let parent = tempfile::tempdir().unwrap();
    let bytes = vignetted_dng(64, 48, None);
    let (w, h) = (reference(&bytes).width(), reference(&bytes).height());
    let mut store = FrameStore::create(parent.path(), &[(w, h), (w + 1, h)]).unwrap();
    store.ingest_bytes(0, &bytes, "dng", 16, "a").unwrap();
    assert!(store.ingest_bytes(0, &bytes, "dng", 16, "again").is_err());
    assert!(store
        .ingest_bytes(1, &bytes, "dng", 16, "wrong size")
        .is_err());
    assert_eq!(store.dims(1), None);
    assert!(store
        .ingest_bytes(2, &bytes, "dng", 16, "out of range")
        .is_err());
}

#[cfg(unix)]
#[test]
fn orphans_of_dead_processes_are_swept() {
    let parent = tempfile::tempdir().unwrap();
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let dead = child.id();
    child.wait().unwrap();
    let orphan = parent.path().join(format!("{DIR_PREFIX}{dead}-0"));
    let live = parent.path().join(format!("{DIR_PREFIX}1-0"));
    let unrelated = parent.path().join("maple-pano-other");
    for dir in [&orphan, &live, &unrelated] {
        std::fs::create_dir(dir).unwrap();
        std::fs::write(dir.join("frame-0000.rgbf32"), [0u8; 12]).unwrap();
    }
    let store = FrameStore::create(parent.path(), &[(1, 1)]).unwrap();
    assert!(!orphan.exists(), "dead process's store swept");
    assert!(live.exists(), "a running process's store is kept");
    assert!(unrelated.exists());
    assert!(store.dir.as_path().exists());
}

/// The first frame of every pano set through the store, read back in
/// 512-row windows and compared with `decode_for_pano`. Needs the
/// gitignored fixtures: `cargo test --release -p maple-pano --lib
/// frame_store -- --ignored --nocapture`.
#[test]
#[ignore = "needs test-fixtures/raws/pano_*; run with --release --ignored"]
fn fixture_frames_read_back_identical_to_decode_for_pano() {
    let raws = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws");
    let Ok(sets) = std::fs::read_dir(&raws) else {
        eprintln!("no fixtures, skipping");
        return;
    };
    let mut sets: Vec<_> = sets
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("pano_"))
        })
        .collect();
    sets.sort();
    let parent = tempfile::tempdir().unwrap();
    for set in sets {
        let mut frames: Vec<_> = std::fs::read_dir(&set)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("dng")))
            .collect();
        frames.sort();
        let Some(path) = frames.first() else { continue };
        let full = reference(&std::fs::read(path).unwrap());
        let mut store =
            FrameStore::create(parent.path(), &[(full.width(), full.height())]).unwrap();
        let started = std::time::Instant::now();
        let ingest = store.ingest_file(0, path, 1008).unwrap();
        let elapsed = started.elapsed();
        for y0 in (0..full.height()).step_by(512) {
            let rows = 512.min(full.height() - y0);
            assert_rows_match(&store.read_planar_rows(0, y0, rows).unwrap(), &full, y0);
        }
        eprintln!(
            "{}: {}x{} identical, banded {}, ingest {elapsed:.2?}",
            path.display(),
            full.width(),
            full.height(),
            ingest.banded
        );
    }
}

#[test]
fn a_failed_ingest_can_be_retried() {
    let parent = tempfile::tempdir().unwrap();
    let bytes = vignetted_dng(64, 48, None);
    let full = reference(&bytes);
    let mut store = FrameStore::create(parent.path(), &[(full.width(), full.height())]).unwrap();
    assert!(store
        .ingest_bytes(0, b"not a raw", "dng", 16, "garbage")
        .is_err());
    store.ingest_bytes(0, &bytes, "dng", 16, "retry").unwrap();
    let (w, h) = store.dims(0).unwrap();
    assert_rows_match(&store.read_planar_rows(0, 0, h).unwrap(), &full, 0);
    assert_eq!(w, full.width());
}

#[test]
fn frames_of_different_sensor_widths_share_the_scratch() {
    let parent = tempfile::tempdir().unwrap();
    let frames = [
        vignetted_dng(150, 92, None),
        vignetted_dng(96, 120, Some(6)),
        vignetted_dng(200, 64, None),
    ];
    let refs: Vec<&[u8]> = frames.iter().map(Vec::as_slice).collect();
    let store = store_of(parent.path(), &refs);
    for (i, bytes) in refs.iter().enumerate() {
        let full = reference(bytes);
        let window = store.read_planar_rows(i, 0, full.height()).unwrap();
        assert_rows_match(&window, &full, 0);
    }
}

#[test]
fn reads_spanning_many_chunks_are_exact() {
    let parent = tempfile::tempdir().unwrap();
    let bytes = vignetted_dng(150, 92, Some(6));
    let store = store_of(parent.path(), &[&bytes]);
    let full = reference(&bytes);
    let row_bytes = full.width() as u64 * BYTES_PER_PIXEL;
    for chunk_bytes in [1, row_bytes, row_bytes * 3 + 5] {
        for (y0, rows) in [(0, full.height()), (5, 17)] {
            let window = store
                .read_planar_rows_chunked(0, y0, rows, chunk_bytes)
                .unwrap();
            assert_rows_match(&window, &full, y0);
        }
    }
}

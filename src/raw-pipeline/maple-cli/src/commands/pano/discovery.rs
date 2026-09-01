//! Manifest-case frame filtering for [`super`] (`pano stitch --manifest`)
//! (#3089).
//!
//! Fixture-directory discovery (`src/scripts/test_pano_pipeline.sh`, or a
//! hand-authored manifest) has no cheap way to know ahead of time that
//! every `*.dng` under a set directory actually belongs to that pano —
//! dev-automation staging leftovers or a wrong-body sample land there too
//! (`test-fixtures/raws/pano_00/test.dng`: a Hasselblad H2D-39 still frame
//! with no `FocalLengthIn35mmFormat`, sitting next to a 3-frame DJI L3D-100c
//! nadir strip). Previously such a frame took down the *whole set*: `stitch`
//! hard-errored with `StitchError::NoFocal` and the harness reported
//! `no-candidate` for a set whose real frames were perfectly stitchable.
//!
//! [`filter_conforming_frames`] is a cheap pre-flight over each case's
//! frame list — metadata-only reads (no develop), the same input
//! `FramePriors::from_metadata` (#2700) uses to seed a camera model — that
//! warns and drops a frame instead of failing the case, when either:
//!
//! - the frame has no derivable 35mm-equivalent focal length (can't seed a
//!   camera model at all, direct EXIF tag or #2700's sensor-geometry
//!   fallback), or
//! - the frame's camera model disagrees with the set's established
//!   majority body (only applied once **at least two** frames agree on a
//!   model — a single reference frame proves nothing about which one is
//!   the stray).
//!
//! This is a backstop, not a replacement for fixture hygiene — a
//! genuinely broken frame from the *right* camera (e.g. corrupt data)
//! still has a plausible camera model and may still have a derivable
//! focal length, so it is not caught here and correctly still fails the
//! set via the normal `stitch()` error path.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use maple_pano::ingest::FramePriors;

/// Per-frame conformance signal: enough to tell whether a listed frame
/// plausibly belongs to the rest of its set, without paying for a full
/// RAW decode.
struct FrameProbe {
    /// Empty when the file couldn't be read/decoded at all — probes as
    /// non-conforming on both signals below.
    camera_model: String,
    has_focal: bool,
}

/// Cheap metadata-only probe (`raw_core::read_pano_metadata`, no develop)
/// for [`filter_conforming_frames`]. An unreadable file probes as
/// non-conforming (empty model, no focal) rather than aborting discovery
/// — [`drop_non_conforming`] warns and drops it same as any other
/// non-conforming frame.
fn probe_frame(path: &Path) -> FrameProbe {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("dng")
        .to_lowercase();
    let Ok(bytes) = std::fs::read(path) else {
        return FrameProbe {
            camera_model: String::new(),
            has_focal: false,
        };
    };
    let Ok(md) = raw_core::read_pano_metadata(&bytes, &ext) else {
        return FrameProbe {
            camera_model: String::new(),
            has_focal: false,
        };
    };
    let has_focal = FramePriors::from_metadata(&md).focal_px.is_some();
    FrameProbe {
        camera_model: md.camera_model,
        has_focal,
    }
}

/// Warn-and-skip non-conforming frames from a manifest case's frame list
/// (#3089): the pure decision logic over already-probed frames, split out
/// from [`filter_conforming_frames`] so it's testable without real `.dng`
/// fixtures on disk. `name` is the case name, used only for the warning's
/// `pano[name]:` prefix. Preserves input order.
fn drop_non_conforming(name: &str, probed: Vec<(PathBuf, FrameProbe)>) -> Vec<PathBuf> {
    let mut model_counts: BTreeMap<String, usize> = BTreeMap::new();
    for (_, probe) in &probed {
        if !probe.camera_model.is_empty() {
            *model_counts.entry(probe.camera_model.clone()).or_insert(0) += 1;
        }
    }
    // Only a model two or more frames agree on counts as "the set's
    // body" — a single frame is not evidence against any other frame.
    let majority_model = model_counts
        .into_iter()
        .filter(|&(_, count)| count >= 2)
        .max_by_key(|&(_, count)| count)
        .map(|(model, _)| model);

    probed
        .into_iter()
        .filter_map(|(path, probe)| {
            let wrong_body = majority_model
                .as_deref()
                .is_some_and(|m| probe.camera_model != m);
            let no_focal = !probe.has_focal;
            if !no_focal && !wrong_body {
                return Some(path);
            }
            let reason = match (no_focal, wrong_body) {
                (true, true) => "no derivable 35mm focal, wrong camera body for this set",
                (true, false) => "no derivable 35mm focal",
                (false, true) => "wrong camera body for this set",
                (false, false) => unreachable!(),
            };
            eprintln!("pano[{name}]: WARN — {}: {reason}, skipped", path.display());
            None
        })
        .collect()
}

/// Probe every frame in `frames` and drop the non-conforming ones (see
/// module docs). This is the entry point [`super::stitch_manifest`] calls
/// before checking the `< 2` frames gate.
pub(super) fn filter_conforming_frames(name: &str, frames: Vec<PathBuf>) -> Vec<PathBuf> {
    let probed: Vec<(PathBuf, FrameProbe)> = frames
        .into_iter()
        .map(|path| {
            let probe = probe_frame(&path);
            (path, probe)
        })
        .collect();
    drop_non_conforming(name, probed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probed(path: &str, camera_model: &str, has_focal: bool) -> (PathBuf, FrameProbe) {
        (
            PathBuf::from(path),
            FrameProbe {
                camera_model: camera_model.to_string(),
                has_focal,
            },
        )
    }

    fn names(kept: Vec<PathBuf>) -> Vec<String> {
        kept.into_iter().map(|p| p.display().to_string()).collect()
    }

    /// The pano_00 shape: 3 real DJI L3D-100c frames + 1 Hasselblad
    /// H2D-39 stray with no derivable focal. The stray is dropped, the
    /// real frames survive.
    #[test]
    fn drops_stray_with_no_focal_and_wrong_body() {
        let kept = drop_non_conforming(
            "pano_00",
            vec![
                probed("0000.DNG", "L3D-100c", true),
                probed("0002.DNG", "L3D-100c", true),
                probed("0003.DNG", "L3D-100c", true),
                probed("test.dng", "Hasselblad H2D-39", false),
            ],
        );
        assert_eq!(names(kept), vec!["0000.DNG", "0002.DNG", "0003.DNG"]);
    }

    /// A frame with a derivable focal but a body that disagrees with an
    /// established two-or-more-frame majority is still dropped —
    /// "wrong body" alone is disqualifying, not just "no focal".
    #[test]
    fn drops_wrong_body_even_with_a_derivable_focal() {
        let kept = drop_non_conforming(
            "set",
            vec![
                probed("a.dng", "L3D-100c", true),
                probed("b.dng", "L3D-100c", true),
                probed("c.dng", "Some Other Body", true),
            ],
        );
        assert_eq!(names(kept), vec!["a.dng", "b.dng"]);
    }

    /// No frame is dropped purely for disagreeing with a single other
    /// frame — a majority needs at least two agreeing frames before
    /// "wrong body" means anything.
    #[test]
    fn no_majority_established_with_only_two_distinct_frames() {
        let kept = drop_non_conforming(
            "set",
            vec![
                probed("a.dng", "Body A", true),
                probed("b.dng", "Body B", true),
            ],
        );
        assert_eq!(names(kept), vec!["a.dng", "b.dng"]);
    }

    /// A frame with no focal is still dropped even when every frame in
    /// the case shares one body (no majority-vote signal needed).
    #[test]
    fn drops_no_focal_frame_without_any_body_disagreement() {
        let kept = drop_non_conforming(
            "set",
            vec![
                probed("a.dng", "L3D-100c", true),
                probed("b.dng", "L3D-100c", false),
            ],
        );
        assert_eq!(names(kept), vec!["a.dng"]);
    }

    /// A fully conforming set passes through unchanged, in order.
    #[test]
    fn keeps_fully_conforming_set_untouched() {
        let kept = drop_non_conforming(
            "set",
            vec![
                probed("a.dng", "L3D-100c", true),
                probed("b.dng", "L3D-100c", true),
            ],
        );
        assert_eq!(names(kept), vec!["a.dng", "b.dng"]);
    }

    /// An unreadable/undecodable frame (empty model, no focal — what
    /// `probe_frame` returns on I/O or decode failure) is dropped like
    /// any other non-conforming frame, not treated as its own model.
    #[test]
    fn unreadable_frame_probe_is_dropped() {
        let kept = drop_non_conforming(
            "set",
            vec![
                probed("a.dng", "L3D-100c", true),
                probed("b.dng", "L3D-100c", true),
                probed("corrupt.dng", "", false),
            ],
        );
        assert_eq!(names(kept), vec!["a.dng", "b.dng"]);
    }

    /// A real end-to-end pass through `filter_conforming_frames` against
    /// the actual pano_00 fixture directory, when it's present on the
    /// machine (fixtures are gitignored — soft-skips otherwise). Proves
    /// the I/O half (`probe_frame`) really does drop `test.dng` and keep
    /// the DJI frames, not just the pure decision logic above.
    #[test]
    fn filter_conforming_frames_drops_real_stray_fixture_when_present() {
        let dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../test-fixtures/raws/pano_00"
        ));
        if !dir.is_dir() {
            eprintln!("skipping: {} not present", dir.display());
            return;
        }
        let frames: Vec<PathBuf> = std::fs::read_dir(dir)
            .expect("read_dir")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("dng"))
                    .unwrap_or(false)
            })
            .collect();
        if frames.len() < 4 {
            eprintln!(
                "skipping: expected >= 4 .dng (3 real + stray), found {}",
                frames.len()
            );
            return;
        }
        let kept = filter_conforming_frames("pano_00", frames);
        assert!(
            kept.iter()
                .all(|p| p.file_name().and_then(|n| n.to_str()) != Some("test.dng")),
            "test.dng should have been dropped, kept: {kept:?}"
        );
        assert!(kept.len() >= 2, "real frames should survive: {kept:?}");
    }
}

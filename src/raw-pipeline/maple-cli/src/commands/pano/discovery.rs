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
        // Only a frame that's otherwise conforming (has a derivable focal)
        // gets a vote for "the set's body" — a cluster of no-focal strays
        // sharing a model must never outvote the real frames and drag them
        // down as "wrong body" too (Jules review on #3131).
        if probe.has_focal && !probe.camera_model.is_empty() {
            *model_counts.entry(probe.camera_model.clone()).or_insert(0) += 1;
        }
    }
    // Only a *strict* majority counts as "the set's body": the top model
    // needs at least two votes (a single frame is not evidence against
    // any other frame) AND no other model tied with it (e.g. two frames
    // from body A and two from body B is a tie, not a majority for
    // either — filtering by it would drop valid frames from whichever
    // body lost the arbitrary tie-break) (Copilot review on #3131).
    let mut counts: Vec<(String, usize)> = model_counts.into_iter().collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let majority_model = match counts.as_slice() {
        [(model, top), tail @ ..] if *top >= 2 && tail.first().map(|(_, c)| c) != Some(top) => {
            Some(model.clone())
        }
        _ => None,
    };

    probed
        .into_iter()
        .filter_map(|(path, probe)| {
            // An empty model means the file couldn't be read/decoded at
            // all (probe_frame's failure shape) — there's no model to
            // compare against the majority, so don't also blame it on
            // "wrong camera body": that's misleading for a file that was
            // never identified as any body at all (Copilot review on
            // #3131).
            let unreadable = probe.camera_model.is_empty();
            let wrong_body = !unreadable
                && majority_model
                    .as_deref()
                    .is_some_and(|m| probe.camera_model != m);
            let no_focal = !probe.has_focal;
            if !unreadable && !no_focal && !wrong_body {
                return Some(path);
            }
            let reason = match (unreadable, no_focal, wrong_body) {
                (true, _, _) => "unreadable or undecodable",
                (false, true, true) => "no derivable 35mm focal, wrong camera body for this set",
                (false, true, false) => "no derivable 35mm focal",
                (false, false, true) => "wrong camera body for this set",
                (false, false, false) => unreachable!(),
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

    /// A tie between two bodies (two frames each) is not a majority for
    /// either — filtering by it would arbitrarily drop one body's real
    /// frames as "wrong body" (Copilot review on #3131).
    #[test]
    fn tied_vote_between_two_bodies_establishes_no_majority() {
        let kept = drop_non_conforming(
            "set",
            vec![
                probed("a.dng", "Body A", true),
                probed("b.dng", "Body A", true),
                probed("c.dng", "Body B", true),
                probed("d.dng", "Body B", true),
            ],
        );
        assert_eq!(names(kept), vec!["a.dng", "b.dng", "c.dng", "d.dng"]);
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

    /// Jules review on #3131: a cluster of no-focal strays that happen to
    /// share a camera model must never outvote the real frames for
    /// "majority body" — only frames with a derivable focal count toward
    /// the majority vote. Without that guard, 3 no-focal strays sharing a
    /// model would outnumber 2 real frames, and the real frames would get
    /// dropped too as "wrong body", failing the whole set.
    #[test]
    fn no_focal_stray_majority_does_not_outvote_real_frames() {
        let kept = drop_non_conforming(
            "set",
            vec![
                probed("a.dng", "L3D-100c", true),
                probed("b.dng", "L3D-100c", true),
                probed("stray1.dng", "Stray Body", false),
                probed("stray2.dng", "Stray Body", false),
                probed("stray3.dng", "Stray Body", false),
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
    ///
    /// `test.dng` itself now lives in the sibling `_stray/` directory
    /// (this PR moved it out of `pano_00` for fixture hygiene — see the
    /// PR description), so `pano_00` alone only has the 3 real frames.
    /// Append the stray back in by hand rather than checking `pano_00`'s
    /// raw file count, so this test still exercises the drop-a-stray
    /// path instead of silently skipping on every machine forever
    /// (Jules review on #3131).
    #[test]
    fn filter_conforming_frames_drops_real_stray_fixture_when_present() {
        let dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../test-fixtures/raws/pano_00"
        ));
        let stray = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../test-fixtures/raws/_stray/test.dng"
        ));
        if !dir.is_dir() || !stray.is_file() {
            eprintln!(
                "skipping: {} and/or {} not present",
                dir.display(),
                stray.display()
            );
            return;
        }
        let mut frames: Vec<PathBuf> = std::fs::read_dir(dir)
            .expect("read_dir")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("dng"))
                    .unwrap_or(false)
            })
            .collect();
        if frames.len() < 3 {
            eprintln!(
                "skipping: expected >= 3 real .dng in pano_00, found {}",
                frames.len()
            );
            return;
        }
        frames.push(stray.to_path_buf());
        let kept = filter_conforming_frames("pano_00", frames);
        assert!(
            kept.iter()
                .all(|p| p.file_name().and_then(|n| n.to_str()) != Some("test.dng")),
            "test.dng should have been dropped, kept: {kept:?}"
        );
        assert!(kept.len() >= 2, "real frames should survive: {kept:?}");
    }
}

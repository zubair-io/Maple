//! Camera-focal seeding at `stitch()`'s stage 0→2 boundary (spec §5.3
//! "Initialization"; ticket #1214's EXIF-less fallback).
//!
//! [`seed_from_priors`] resolves each frame's starting focal length:
//! its own EXIF-derived value when present, the shared median of
//! whatever the set does have otherwise, and — only when NOT ONE frame
//! in the whole set carries a usable EXIF focal — an assumed-FOV
//! bootstrap just accurate enough to get match-graph verification
//! running at all (rotation verification needs bearings, and a bearing
//! needs *some* focal length before it can be computed at all).
//!
//! When that bootstrap path is taken, [`stitch`](super::stitch) builds
//! the match graph once with the assumed focal, then calls
//! [`refine_from_homography`] to replace it with the real
//! self-calibration estimate ([`crate::ba::focal::homography_focal_seed_px`])
//! and rebuilds the graph a second time — [`rebuild_graph_with_focal`]
//! reuses the first pass's cached LightGlue correspondences rather than
//! re-running ONNX inference, the same cache-reuse pattern
//! [`super::tile_stitch::run_tile_branch`] uses for its unit-focal
//! rebuild. `< 1` verified pair on the bootstrap graph is the hard-error
//! floor (spec §5.3: "hard error only when neither is computable").

use super::types::StitchError;
use std::collections::HashMap;

use crate::ba;
use crate::camera::{focal_px_for_hfov, Camera};
use crate::graph::{
    build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage, MatchGraph,
};
use crate::ingest::{FrameMeta, FramePriors};
use crate::robust::RobustOptions;
use crate::twoview::PixelCorrespondence;

/// Where the shared camera focal seed came from — surfaced in the
/// stitch report so the operator knows the pipeline had no camera
/// metadata to work from (ticket #1214: "report which seed source was
/// used per set").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocalSeedSource {
    /// At least one frame carried a usable EXIF-derived focal length
    /// (direct `FocalLengthIn35mmFormat`, or the sensor-geometry
    /// derivation, #2700); frames missing their own value use the
    /// shared median of what the set does have.
    Exif,
    /// No frame carried one; the seed came from homography
    /// self-calibration over the match graph built with an
    /// assumed-FOV bootstrap camera.
    HomographyFallback,
}

impl FocalSeedSource {
    pub fn as_str(self) -> &'static str {
        match self {
            FocalSeedSource::Exif => "exif",
            FocalSeedSource::HomographyFallback => "homography",
        }
    }
}

/// Assumed horizontal FOV (degrees) used to bootstrap cameras just far
/// enough to run match-graph verification when no frame in the set
/// carries an EXIF-derived focal length. A typical handheld/DSLR
/// wide-to-normal value; it does not need to be accurate — RANSAC
/// two-view verification tolerates a materially wrong focal seed as
/// long as the true relative rotation between overlapping frames is
/// modest, and the real focal comes from [`refine_from_homography`]
/// immediately afterward. Bundle adjustment (`crate::ba`) then refines
/// it jointly with rotation regardless of source.
const BOOTSTRAP_ASSUMED_HFOV_DEG: f64 = 60.0;

/// Per-frame focal seed (full-resolution pixels, index-aligned with the
/// input frame list) plus which source produced it.
pub struct FocalSeed {
    pub source: FocalSeedSource,
    pub full_px: Vec<f64>,
}

/// Resolve the initial per-frame focal seed (spec §5.3; see module
/// docs). Always succeeds — the EXIF-less case bootstraps from an
/// assumed FOV rather than failing; failure (when even the bootstrap
/// can't produce a verified pair to refine from) is reported later by
/// [`refine_from_homography`] returning `None`.
pub(super) fn seed_from_priors(metas: &[FrameMeta]) -> FocalSeed {
    let priors: Vec<FramePriors> = metas.iter().map(|m| m.priors.clone()).collect();
    match ba::init::focal_seed_px(&priors) {
        Some(seed) => FocalSeed {
            source: FocalSeedSource::Exif,
            full_px: metas
                .iter()
                .map(|m| m.priors.focal_px.unwrap_or(seed))
                .collect(),
        },
        None => FocalSeed {
            source: FocalSeedSource::HomographyFallback,
            full_px: metas
                .iter()
                .map(|m| focal_px_for_hfov(BOOTSTRAP_ASSUMED_HFOV_DEG, m.full_width))
                .collect(),
        },
    }
}

/// Build the full-resolution and proxy-scale [`GraphImage`] sets from a
/// per-frame full-resolution focal vector — the one construction shared
/// by the initial bootstrap build and, on the fallback path, the
/// post-refinement rebuild.
pub(super) fn build_graph_images(
    metas: &[FrameMeta],
    full_focal_px: &[f64],
    proxy_dims: &[(u32, u32)],
    proxy_scale: &[(f64, f64)],
) -> (Vec<GraphImage>, Vec<GraphImage>) {
    let full_images: Vec<GraphImage> = metas
        .iter()
        .zip(full_focal_px)
        .map(|(m, &focal_px)| GraphImage {
            camera: Camera::new([0.0; 3], focal_px, 0.0, 0.0, m.full_width, m.full_height),
            prior_rotation: m.priors.gimbal.as_ref().map(ba::init::rotation_from_gimbal),
        })
        .collect();
    let proxy_images: Vec<GraphImage> = full_images
        .iter()
        .enumerate()
        .map(|(i, img)| GraphImage {
            camera: Camera::new(
                [0.0; 3],
                img.camera.focal_px / proxy_scale[i].0,
                0.0,
                0.0,
                proxy_dims[i].0,
                proxy_dims[i].1,
            ),
            prior_rotation: img.prior_rotation,
        })
        .collect();
    (full_images, proxy_images)
}

/// Estimate the real shared focal from the bootstrap graph's verified
/// pairs (proxy-pixel coordinates), and convert it to a per-frame
/// full-resolution focal vector via each frame's proxy→full scale.
/// `None` propagates the caller's hard-error condition: fewer than 1
/// verified pair on the bootstrap graph, so there is nothing to
/// self-calibrate from.
pub(super) fn refine_from_homography(
    graph: &MatchGraph,
    proxy_dims: &[(u32, u32)],
    proxy_scale: &[(f64, f64)],
) -> Option<Vec<f64>> {
    let proxy_focal_px = ba::focal::homography_focal_seed_px(graph, proxy_dims)?;
    Some(
        proxy_scale
            .iter()
            .map(|&(sx, _)| proxy_focal_px * sx)
            .collect(),
    )
}

/// Rebuild the match graph against `proxy_images` (new camera
/// intrinsics), reusing every cached correspondence from the first pass
/// by `(a, b)` key and falling back to `fetch` — the live ONNX matcher
/// in production, a synthetic generator in tests — only for a candidate
/// pair the first pass never requested (possible when
/// [`crate::graph::GimbalPriorProvider`]'s field-of-view-based
/// nomination widens or narrows between the bootstrap and refined
/// focal).
pub(super) fn rebuild_graph_with_focal(
    proxy_images: &[GraphImage],
    cache: &HashMap<(usize, usize), Vec<PixelCorrespondence>>,
    mut fetch: impl FnMut(usize, usize) -> Vec<PixelCorrespondence>,
) -> MatchGraph {
    build_match_graph(
        proxy_images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| match cache.get(&(a, b)) {
            Some(cached) => cached.clone(),
            None => fetch(a, b),
        },
        &RobustOptions::default(),
    )
}

/// Full homography-fallback refinement, in place — the single call
/// `stitch()` makes after its first (bootstrap) `build_match_graph`.
/// A no-op (`Ok(())`) when `focal_seed.source` is
/// [`FocalSeedSource::Exif`]. Otherwise: self-calibrates the real focal
/// from `graph`, rebuilds `full_images`/`proxy_images` at that focal,
/// and rebuilds `graph` against them (reusing `raw_matches_cache`,
/// appending anything `fetch` supplies for an uncached pair). Returns
/// `Err(StitchError::NoFocalSeed)` when [`refine_from_homography`] can't produce an estimate —
/// the caller's hard-error floor (spec §5.3: fewer than 1 verified
/// pair). Otherwise `Err(StitchError::MatchFailed(failures))`: any `fetch` error for an uncached
/// pair, formatted `"pair (a,b): <cause>"` — the caller decides whether
/// a non-empty list is fatal (mirrors the bootstrap build's own
/// `match_failures` accumulation).
#[allow(clippy::too_many_arguments)]
pub(super) fn refine_if_needed(
    focal_seed: &mut FocalSeed,
    metas: &[FrameMeta],
    proxy_dims: &[(u32, u32)],
    proxy_scale: &[(f64, f64)],
    graph: &mut MatchGraph,
    full_images: &mut Vec<GraphImage>,
    proxy_images: &mut Vec<GraphImage>,
    raw_matches_cache: &mut Vec<((usize, usize), Vec<PixelCorrespondence>)>,
    mut fetch: impl FnMut(usize, usize) -> Result<Vec<PixelCorrespondence>, String>,
) -> Result<(), StitchError> {
    if focal_seed.source != FocalSeedSource::HomographyFallback {
        return Ok(());
    }
    focal_seed.full_px =
        refine_from_homography(graph, proxy_dims, proxy_scale).ok_or(StitchError::NoFocalSeed)?;
    let (refined_full, refined_proxy) =
        build_graph_images(metas, &focal_seed.full_px, proxy_dims, proxy_scale);
    *full_images = refined_full;
    *proxy_images = refined_proxy;

    // Moved (not cloned) into the lookup map — `rebuild_graph_with_focal`
    // below still clones on an actual cache *hit* (unavoidable:
    // `build_match_graph` needs an owned return value while the cache
    // stays intact for reuse), but a pair nobody re-requests now costs
    // nothing, instead of always paying a full deep-clone up front.
    let cache: HashMap<(usize, usize), Vec<PixelCorrespondence>> =
        std::mem::take(raw_matches_cache).into_iter().collect();
    let mut newly_fetched: Vec<((usize, usize), Vec<PixelCorrespondence>)> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    *graph = rebuild_graph_with_focal(proxy_images, &cache, |a, b| match fetch(a, b) {
        Ok(corrs) => {
            newly_fetched.push(((a, b), corrs.clone()));
            corrs
        }
        Err(e) => {
            failures.push(format!("pair ({a},{b}): {e}"));
            Vec::new()
        }
    });
    *raw_matches_cache = cache.into_iter().chain(newly_fetched).collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(StitchError::MatchFailed(failures))
    }
}

// Synthetic correspondences come from `testkit` — same gate as the
// integration suites that use it (#3236).
#[cfg(all(test, feature = "testkit"))]
#[path = "focal_bootstrap_tests.rs"]
mod tests;

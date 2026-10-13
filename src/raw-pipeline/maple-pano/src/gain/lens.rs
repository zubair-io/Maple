//! Lens identity for the blind vignette estimate (#4522): which frames
//! share a falloff, and the per-group result surfaced in stitch reports.

use raw_core::FalloffCorrection;

use super::vignette::FalloffFit;
use crate::ingest::FrameMeta;

/// Lens identity of each frame that still carries its falloff, as an
/// index into `labels`. Frames whose ingest corrected falloff are `None`
/// and never take part in the estimate.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LensGroups {
    pub labels: Vec<String>,
    pub of_frame: Vec<Option<usize>>,
}

#[derive(Debug, Clone, PartialEq)]
struct LensKey {
    make: String,
    model: String,
    focal_decimm: Option<i64>,
    dims: (u32, u32),
}

impl LensKey {
    fn of(meta: &FrameMeta) -> Option<Self> {
        (meta.falloff_correction == FalloffCorrection::None).then(|| Self {
            make: meta.camera_make.trim().to_string(),
            model: meta.camera_model.trim().to_string(),
            focal_decimm: meta
                .priors
                .focal_mm
                .filter(|f| f.is_finite() && *f > 0.0)
                .map(|f| (f as f64 * 10.0).round() as i64),
            // Elliptical r² is invariant under a 90° turn, so portrait and
            // landscape frames of one lens share a group.
            dims: (
                meta.full_width.min(meta.full_height),
                meta.full_width.max(meta.full_height),
            ),
        })
    }

    fn label(&self) -> String {
        let focal = self
            .focal_decimm
            .map(|d| format!("{:.1}mm", d as f64 / 10.0));
        [Some(self.make.clone()), Some(self.model.clone()), focal]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

impl LensGroups {
    pub fn from_metas<'a>(metas: impl IntoIterator<Item = &'a FrameMeta>) -> Self {
        let keys: Vec<Option<LensKey>> = metas.into_iter().map(LensKey::of).collect();
        let distinct = keys
            .iter()
            .flatten()
            .fold(Vec::<&LensKey>::new(), |acc, k| {
                if acc.contains(&k) {
                    acc
                } else {
                    acc.into_iter().chain(std::iter::once(k)).collect()
                }
            });
        Self {
            labels: distinct.iter().map(|k| k.label()).collect(),
            of_frame: keys
                .iter()
                .map(|k| {
                    k.as_ref()
                        .and_then(|k| distinct.iter().position(|d| *d == k))
                })
                .collect(),
        }
    }

    /// Every frame already falloff-corrected at ingest.
    pub fn ingest_corrected(frames: usize) -> Self {
        Self {
            labels: Vec::new(),
            of_frame: vec![None; frames],
        }
    }

    /// The groups restricted to `frames` (indices into `of_frame`), in that
    /// order, with labels renumbered by first appearance — what
    /// [`Self::from_metas`] gives for those frames' metadata alone.
    pub fn for_frames(&self, frames: &[usize]) -> Self {
        let kept_groups: Vec<Option<usize>> = frames.iter().map(|&f| self.of_frame[f]).collect();
        let distinct = kept_groups
            .iter()
            .flatten()
            .fold(Vec::<usize>::new(), |acc, &g| {
                if acc.contains(&g) {
                    acc
                } else {
                    acc.into_iter().chain(std::iter::once(g)).collect()
                }
            });
        Self {
            labels: distinct.iter().map(|&g| self.labels[g].clone()).collect(),
            of_frame: kept_groups
                .iter()
                .map(|g| g.and_then(|g| distinct.iter().position(|&d| d == g)))
                .collect(),
        }
    }

    pub(crate) fn any(&self) -> bool {
        self.of_frame.iter().any(Option::is_some)
    }

    /// Each frame's applied `q` from the per-group estimate (0 when
    /// corrected at ingest).
    pub(crate) fn q_of_frame(&self, fits: &[FalloffFit]) -> Vec<f64> {
        self.of_frame
            .iter()
            .map(|g| g.map_or(0.0, |g| fits[g].q))
            .collect()
    }

    /// Report entries for the groups, listing the frames among `frames`
    /// (indices into `of_frame`) that belong to each.
    pub(crate) fn report(&self, fits: &[FalloffFit], frames: &[usize]) -> Vec<LensFalloff> {
        self.labels
            .iter()
            .zip(fits)
            .enumerate()
            .map(|(g, (lens, fit))| LensFalloff {
                lens: lens.clone(),
                frames: frames
                    .iter()
                    .copied()
                    .filter(|f| self.of_frame[*f] == Some(g))
                    .collect(),
                q: fit.q as f32,
                q_unconstrained: fit.q_unconstrained as f32,
                q_sigma: fit.sigma as f32,
                estimable: fit.estimable,
            })
            .collect()
    }
}

/// The estimated falloff of one lens group, for the stitch report.
#[derive(Debug, Clone, PartialEq)]
pub struct LensFalloff {
    pub lens: String,
    pub frames: Vec<usize>,
    /// The applied `q`: 0 when not estimable or when the data want a
    /// negative one (corners brighter), which the model cannot express.
    pub q: f32,
    /// Linearised `q` without the non-negativity bound.
    pub q_unconstrained: f32,
    /// Standard error of `q_unconstrained`.
    pub q_sigma: f32,
    /// `false` when the overlaps cannot resolve `q` (too few, or radius
    /// differences collinear with a gain step); `q` is then 0 by default,
    /// not a measurement.
    pub estimable: bool,
}

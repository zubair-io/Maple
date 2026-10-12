//! Lens identity for the blind vignette estimate (#4522): which frames
//! share a falloff, and the per-group result surfaced in stitch reports.

use raw_core::FalloffCorrection;

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

    pub(crate) fn any(&self) -> bool {
        self.of_frame.iter().any(Option::is_some)
    }

    /// Each frame's `q` from the per-group estimate (0 when corrected at
    /// ingest).
    pub(crate) fn q_of_frame(&self, q: &[f64]) -> Vec<f64> {
        self.of_frame
            .iter()
            .map(|g| g.map_or(0.0, |g| q[g]))
            .collect()
    }

    /// Report entries for the groups, listing the frames among `frames`
    /// (indices into `of_frame`) that belong to each.
    pub(crate) fn report(&self, q: &[f64], frames: &[usize]) -> Vec<LensFalloff> {
        self.labels
            .iter()
            .zip(q)
            .enumerate()
            .map(|(g, (lens, q))| LensFalloff {
                lens: lens.clone(),
                frames: frames
                    .iter()
                    .copied()
                    .filter(|f| self.of_frame[*f] == Some(g))
                    .collect(),
                q: *q as f32,
            })
            .collect()
    }
}

/// The estimated falloff of one lens group, for the stitch report.
#[derive(Debug, Clone, PartialEq)]
pub struct LensFalloff {
    pub lens: String,
    pub frames: Vec<usize>,
    pub q: f32,
}

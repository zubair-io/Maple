//! §5.2(c): descriptor top-k candidate retrieval for unordered /
//! metadata-free input (ticket #1215).
//!
//! [`CaptureOrderProvider`](super::CaptureOrderProvider) needs a
//! meaningful capture order and
//! [`GimbalPriorProvider`](super::GimbalPriorProvider) needs gimbal
//! metadata; neither exists for a scanned film set or a mixed-shoot
//! DSLR burst — exactly the M1b grid-set failure mode: with no
//! candidates nominated at all, the match graph fragments into
//! disconnected singletons regardless of how well the frames actually
//! overlap. [`DescriptorTopKProvider`] closes that gap by nominating
//! candidates from image content alone: for each frame, rank every
//! other frame by descriptor similarity and take the top `k`.
//!
//! # Design note: a struct field, not a trait-signature change
//!
//! [`CandidateProvider`](super::CandidateProvider) is `fn candidates(&self,
//! images: &[GraphImage]) -> Vec<(usize, usize)>` — a pure function of
//! the image list, by design (module docs, "Determinism": candidate
//! order must not perturb other providers' verification seeds). This
//! provider needs each frame's ALIKED descriptors, which
//! [`GraphImage`](super::GraphImage) does not carry (intrinsics only —
//! module docs: "Only the intrinsics ... are read"). Two ways to supply
//! that: widen the trait to take a second, provider-specific parameter
//! (forces every existing and future implementor to accept a parameter
//! it ignores, and the M1a contract to be renegotiated), or capture the
//! feature sets in the provider's own constructor and let `images`
//! continue to mean what it already means. This picks the latter:
//! `DescriptorTopKProvider<'a>` borrows `feature_sets` at construction,
//! `candidates` still takes only `&[GraphImage]` (used solely for the
//! frame count / bounds check), and every other [`CandidateProvider`]
//! implementor — present or future — is untouched.
//!
//! # Similarity choice and cost
//!
//! Each frame's ALIKED descriptor set (already L2-normalized per
//! keypoint by the network — [`crate::features::FeatureSet`] docs) is
//! **mean-pooled** into one L2-renormalized vector per frame: the
//! simplest vocabulary-free global descriptor (no k-means codebook to
//! build, tune, or ship, unlike VLAD or bag-of-words). This is adequate
//! because the provider only has to *rank* candidates for the real
//! geometric check ([`crate::robust::verify_pair`]) to run on
//! afterward, not verify them itself — a coarse similarity ranking that
//! reliably surfaces true overlapping pairs in the top few is enough.
//! Cosine similarity between two pooled, unit-norm vectors is then a
//! plain dot product.
//!
//! Cost: pooling is one pass over every keypoint's descriptor per frame
//! (`O(N · mean_keypoints · descriptor_dim)`); ranking is a full
//! pairwise similarity matrix (`O(N² · descriptor_dim)`). At the
//! spec's own N ≤ ~150 frames and a 128-D descriptor this is a few
//! million multiply-adds total — trivial next to a single ONNX
//! inference call (ticket's own sizing note).

use crate::features::FeatureSet;
use crate::graph::{CandidateProvider, GraphImage};

/// Neighbors nominated per frame when the caller doesn't override it
/// (spec §5.2(c) default).
pub const DEFAULT_TOP_K: usize = 6;

/// §5.2(c) candidate provider: top-k retrieval by mean-descriptor
/// similarity. See the module docs for the similarity choice and why
/// the feature sets are a constructor field rather than a trait
/// parameter.
pub struct DescriptorTopKProvider<'a> {
    /// Feature sets, index-aligned with the image list `candidates` is
    /// called with. A length mismatch yields no candidates rather than
    /// panicking (`candidates` degrades to empty, like every other
    /// provider does on out-of-range input).
    pub feature_sets: &'a [FeatureSet],
    /// Neighbors nominated per frame.
    pub k: usize,
}

impl<'a> DescriptorTopKProvider<'a> {
    /// `feature_sets` at the spec default `k` ([`DEFAULT_TOP_K`]).
    pub fn new(feature_sets: &'a [FeatureSet]) -> Self {
        Self {
            feature_sets,
            k: DEFAULT_TOP_K,
        }
    }
}

impl CandidateProvider for DescriptorTopKProvider<'_> {
    fn name(&self) -> &'static str {
        "descriptor-topk"
    }

    fn candidates(&self, images: &[GraphImage]) -> Vec<(usize, usize)> {
        let n = images.len();
        if n < 2 || self.k == 0 || self.feature_sets.len() != n {
            return Vec::new();
        }

        let pooled: Vec<Vec<f32>> = self.feature_sets.iter().map(pooled_descriptor).collect();
        // A frame with no descriptor signal (zero keypoints) has no
        // meaningful direction to rank neighbors by, and is an equally
        // meaningless match target for everyone else — excluded from
        // both directions below, rather than let index-order
        // tie-breaking nominate it/for it anyway (review: Copilot).
        let has_signal: Vec<bool> = pooled.iter().map(|p| p.iter().any(|&v| v != 0.0)).collect();

        let mut out = Vec::with_capacity(n * self.k.min(n - 1));
        for i in 0..n {
            if !has_signal[i] {
                continue;
            }
            // Deterministic: descending similarity, ties broken by
            // ascending index, so the ranking never depends on sort
            // stability or float-comparison edge cases beyond `NaN`
            // (which the `has_signal` filter above already excludes).
            let mut ranked: Vec<(usize, f32)> = (0..n)
                .filter(|&j| j != i && has_signal[j])
                .map(|j| (j, cosine(&pooled[i], &pooled[j])))
                .collect();
            ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            out.extend(ranked.into_iter().take(self.k).map(|(j, _)| (i, j)));
        }
        out
    }
}

/// Mean-pool a frame's per-keypoint descriptors into one L2-normalized
/// global descriptor (see module docs). An empty (zero-keypoint) frame
/// pools to an all-zero vector, which [`cosine`] treats as similarity
/// `0.0` against everything — such a frame is simply never a useful
/// candidate, not a divide-by-zero.
fn pooled_descriptor(fs: &FeatureSet) -> Vec<f32> {
    let dim = fs.descriptor_dim;
    let mut sum = vec![0.0_f32; dim];
    for i in 0..fs.len() {
        for (s, &v) in sum.iter_mut().zip(fs.descriptor(i)) {
            *s += v;
        }
    }
    let norm = sum.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for v in sum.iter_mut() {
            *v /= norm;
        }
    }
    sum
}

/// Cosine similarity between two vectors of equal length. Both
/// `pooled_descriptor` outputs are already unit-norm (or all-zero), so
/// this is exactly a dot product — no re-normalization needed here.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

// Synthetic correspondences come from `testkit` — same gate as the
// integration suites that use it (#3236).
#[cfg(all(test, feature = "testkit"))]
#[path = "descriptor_topk_tests.rs"]
mod tests;

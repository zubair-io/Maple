//! Clean-room classical detector + matcher (`classical-features`, #4523).
//!
//! The ONNX-free fallback for [`crate::features`]: a pure-CPU front end
//! that produces the same [`FeatureSet`] / [`crate::matching::MlMatch`]
//! records the ALIKED + LightGlue path does, so everything downstream
//! (glue, match graph, verification, BA) is shared unchanged.
//!
//! ```text
//! LinearRgbFrame ─ log luma ─ Gaussian pyramid (octaves × levels)
//!   ─ scale-normalised Harris (AC−B²)/(A+C+ε) + curvature gate
//!   ─ scale-space NMS + sub-texel peak ─ `max_keypoints`, grid-spread
//!   ─ dominant orientation ─ 4×4×8 gradient histogram (128-D, RootSIFT)
//! ```
//!
//! Matching is mutual nearest neighbour plus a ratio test
//! ([`match_classical`]). Keypoints use the crate-wide continuous pixel
//! convention ([`crate::camera`]); the pyramid's box decimation keeps an
//! octave-`o` coordinate `u` at exactly `u · 2^o` in the source frame.

mod descriptor;
mod harris;
mod matcher;
mod pyramid;

pub use matcher::{match_classical, ClassicalMatchOptions};

use crate::features::{FeatureSet, Keypoint, LinearRgbFrame};
use harris::{harris_response, scale_space_maxima, Candidate, ExtremaOptions};
use pyramid::{
    downsample_half, gaussian_blur, log_luma, octave_levels, GrayImage, ScaleLevel, INPUT_SIGMA,
};

/// Smallest octave edge worth detecting on (the descriptor patch at the
/// coarsest level spans ~40 px).
const MIN_OCTAVE_EDGE: usize = 64;
/// Cells per side of the keypoint-selection grid.
const SELECTION_GRID: usize = 8;

/// Detector tunables.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClassicalOptions {
    /// Keypoints kept per frame. 4× ALIKED's 2000: a hand-built
    /// descriptor discriminates less, so repetitive texture (rows of roof
    /// dormers on pano_03) loses most matches to the ratio test, and the
    /// verified-inlier count per pair only clears the tile verifier with
    /// the larger pool (60 → 236–298 inliers on pano_03's weakest pairs).
    pub max_keypoints: usize,
    /// Upper bound on pyramid octaves (fewer when the frame is small).
    pub max_octaves: usize,
    /// Detection levels per octave.
    pub levels_per_octave: usize,
    /// Blur of each octave's base level, in that octave's pixels.
    pub base_sigma: f32,
    /// Minimum scale-normalised Harris response (log-luma units).
    pub response_floor: f32,
    /// Curvature gate: maximum structure-tensor eigenvalue ratio.
    pub edge_ratio: f32,
    /// Spatial non-maximum-suppression radius, in level pixels.
    pub nms_radius: usize,
}

impl Default for ClassicalOptions {
    fn default() -> Self {
        Self {
            max_keypoints: 8000,
            max_octaves: 4,
            levels_per_octave: 3,
            base_sigma: 1.2,
            response_floor: 1e-4,
            edge_ratio: 10.0,
            nms_radius: 2,
        }
    }
}

/// Detect and describe keypoints on one scene-linear frame.
pub fn detect_classical(frame: &LinearRgbFrame, opts: &ClassicalOptions) -> FeatureSet {
    let base = gaussian_blur(
        &log_luma(frame),
        (opts.base_sigma.powi(2) - INPUT_SIGMA.powi(2))
            .max(0.0)
            .sqrt(),
    );
    let octaves = build_octaves(base, opts);
    let extrema = ExtremaOptions {
        response_floor: opts.response_floor,
        nms_radius: opts.nms_radius,
    };
    let mut candidates: Vec<Candidate> = octaves
        .iter()
        .enumerate()
        .flat_map(|(o, levels)| {
            let responses: Vec<Vec<f32>> = levels
                .iter()
                .map(|l| harris_response(l, opts.edge_ratio))
                .collect();
            scale_space_maxima(o, levels, &responses, opts.levels_per_octave, &extrema)
        })
        .collect();
    candidates.sort_by(|a, b| {
        b.response
            .total_cmp(&a.response)
            .then(a.octave.cmp(&b.octave))
            .then(a.level.cmp(&b.level))
            .then(a.y.total_cmp(&b.y))
            .then(a.x.total_cmp(&b.x))
    });
    let peak = candidates.first().map_or(1.0, |c| c.response);
    let mut described: Vec<(Keypoint, Vec<f32>)> = spread_across_grid(&candidates, frame)
        .into_iter()
        .filter_map(|c| {
            let image = &octaves[c.octave][c.level].image;
            let angle = descriptor::dominant_orientation(image, c.x, c.y, c.sigma);
            let desc = descriptor::describe(image, c.x, c.y, c.sigma, angle)?;
            let to_source = (1u32 << c.octave) as f32;
            Some((
                Keypoint {
                    x: c.x * to_source,
                    y: c.y * to_source,
                    score: c.response / peak,
                },
                desc,
            ))
        })
        .take(opts.max_keypoints)
        .collect();
    described.sort_by(|(a, _), (b, _)| b.score.total_cmp(&a.score));
    FeatureSet {
        keypoints: described.iter().map(|(k, _)| *k).collect(),
        descriptors: described.into_iter().flat_map(|(_, d)| d).collect(),
        descriptor_dim: descriptor::DESCRIPTOR_DIM,
        norm_keypoints: Vec::new(),
    }
}

/// Reorders response-sorted candidates so every cell of a
/// `SELECTION_GRID`² grid contributes its best point before any cell
/// contributes its second. A global top-k would spend the whole budget on
/// the few high-contrast regions (cloud edges, a coastline) and leave
/// frames of open water or sky with no matchable support elsewhere.
fn spread_across_grid<'a>(
    candidates: &'a [Candidate],
    frame: &LinearRgbFrame,
) -> Vec<&'a Candidate> {
    let cell = |c: &Candidate| {
        let to_source = (1u32 << c.octave) as f32;
        let gx = (c.x * to_source * SELECTION_GRID as f32 / frame.width as f32) as usize;
        let gy = (c.y * to_source * SELECTION_GRID as f32 / frame.height as f32) as usize;
        gy.min(SELECTION_GRID - 1) * SELECTION_GRID + gx.min(SELECTION_GRID - 1)
    };
    let (mut ranked, _) = candidates.iter().fold(
        (
            Vec::with_capacity(candidates.len()),
            vec![0usize; SELECTION_GRID * SELECTION_GRID],
        ),
        |(mut ranked, mut seen), c| {
            let k = cell(c);
            ranked.push((seen[k], c));
            seen[k] += 1;
            (ranked, seen)
        },
    );
    ranked.sort_by_key(|&(rank, _)| rank);
    ranked.into_iter().map(|(_, c)| c).collect()
}

fn build_octaves(base: GrayImage, opts: &ClassicalOptions) -> Vec<Vec<ScaleLevel>> {
    let mut octaves: Vec<Vec<ScaleLevel>> = Vec::new();
    let mut next = Some(base);
    while let Some(image) = next.take() {
        if octaves.len() >= opts.max_octaves || image.width.min(image.height) < MIN_OCTAVE_EDGE {
            break;
        }
        let levels = octave_levels(image, opts.base_sigma, opts.levels_per_octave);
        next = levels.last().map(|l| downsample_half(&l.image));
        octaves.push(levels);
    }
    octaves
}

#[cfg(test)]
mod tests {
    use super::*;

    fn textured_frame(width: u32, height: u32, shift: (u32, u32)) -> LinearRgbFrame {
        let hash = |x: u32, y: u32| {
            let h = (x.wrapping_mul(0x9E37_79B1) ^ y.wrapping_mul(0x85EB_CA6B))
                .wrapping_mul(0xC2B2_AE35);
            (h >> 16) as f32 / 65535.0
        };
        let cell = 9;
        let pixels = (0..width * height)
            .flat_map(|i| {
                let (x, y) = (i % width + shift.0, i / width + shift.1);
                let v = 0.05 + 0.8 * hash(x / cell, y / cell);
                [v, v, v]
            })
            .collect();
        LinearRgbFrame::new(width, height, pixels).expect("frame")
    }

    #[test]
    fn detection_is_deterministic_and_bounded() {
        let frame = textured_frame(256, 192, (0, 0));
        let opts = ClassicalOptions {
            max_keypoints: 150,
            ..ClassicalOptions::default()
        };
        let a = detect_classical(&frame, &opts);
        let b = detect_classical(&frame, &opts);
        assert!(!a.is_empty() && a.len() <= 150);
        assert_eq!(a.keypoints, b.keypoints);
        assert_eq!(a.descriptors, b.descriptors);
        assert_eq!(a.descriptors.len(), a.len() * a.descriptor_dim);
        assert!(a.keypoints.windows(2).all(|w| w[0].score >= w[1].score));
        assert!(a
            .keypoints
            .iter()
            .all(|k| (0.0..256.0).contains(&k.x) && (0.0..192.0).contains(&k.y)));
    }

    #[test]
    fn translated_frame_matches_with_the_known_shift() {
        let a = detect_classical(
            &textured_frame(256, 192, (0, 0)),
            &ClassicalOptions::default(),
        );
        let b = detect_classical(
            &textured_frame(256, 192, (13, 7)),
            &ClassicalOptions::default(),
        );
        let matches = match_classical(&a, &b, &ClassicalMatchOptions::default());
        assert!(matches.len() >= 30, "{} matches", matches.len());
        let consistent = matches
            .iter()
            .filter(|m| ((m.x0 - m.x1) - 13.0).abs() < 1.0 && ((m.y0 - m.y1) - 7.0).abs() < 1.0)
            .count();
        assert!(
            consistent * 10 >= matches.len() * 9,
            "{consistent} of {} matches follow the shift",
            matches.len()
        );
    }
}

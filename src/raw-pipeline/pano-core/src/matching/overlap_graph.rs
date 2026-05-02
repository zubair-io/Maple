//! Pose-metadata overlap graph for choosing bounded image-pair candidates.
//!
//! This module does not match features. It decides which image pairs are worth
//! sending to a matcher when we already have approximate camera orientation and
//! intrinsics metadata. The intent is to keep multi-row panoramas connected
//! without falling back to an all-pairs search.

use std::collections::{HashSet, VecDeque};

use nalgebra::{Matrix3, Vector3};

use crate::error::PanoError;

const TWO_PI: f64 = std::f64::consts::PI * 2.0;
const DEFAULT_HORIZONTAL_FOV_RAD: f64 = std::f64::consts::FRAC_PI_2;
const DEFAULT_VERTICAL_FOV_RAD: f64 = std::f64::consts::FRAC_PI_3;

/// Why a pair was selected for feature matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PairCandidateReason {
    /// Adjacent yaw samples within the same pitch row.
    Horizontal,
    /// Nearest-yaw samples between adjacent pitch rows.
    Vertical,
    /// A same-row one-image skip link, useful for robust BA constraints.
    Skip,
    /// First/last same-row link across the yaw wrap.
    Loop,
}

/// A bounded candidate edge in the panorama overlap graph.
#[derive(Debug, Clone, PartialEq)]
pub struct PairCandidate {
    /// First pose index in the caller's input order.
    pub a: usize,
    /// Second pose index in the caller's input order.
    pub b: usize,
    pub reason: PairCandidateReason,
    /// Shortest absolute yaw separation in radians.
    pub yaw_delta_rad: f64,
    /// Absolute pitch separation in radians.
    pub pitch_delta_rad: f64,
    /// Spherical angular separation between view directions in radians.
    pub angular_distance_rad: f64,
    /// Conservative 0..1 overlap estimate from focal length and image size.
    pub estimated_overlap: f64,
}

/// Compact pose metadata used by the overlap-graph builder.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PoseSummary {
    /// Yaw in radians, normalized internally when comparing poses.
    pub yaw_rad: f64,
    /// Pitch in radians.
    pub pitch_rad: f64,
    /// Focal length in pixels. Non-positive values fall back to a generic FOV.
    pub focal_px: f64,
    /// Image dimensions in pixels.
    pub image_size: (u32, u32),
}

impl PoseSummary {
    pub fn new(yaw_rad: f64, pitch_rad: f64, focal_px: f64, image_size: (u32, u32)) -> Self {
        Self {
            yaw_rad,
            pitch_rad,
            focal_px,
            image_size,
        }
    }

    /// Derive yaw and pitch from a camera-to-world rotation matrix.
    ///
    /// The camera's forward axis is treated as +Z in camera space. This matches
    /// the pure-rotation convention used by `predicted_homography`.
    pub fn from_rotation(rotation: &Matrix3<f64>, focal_px: f64, image_size: (u32, u32)) -> Self {
        let forward = rotation * Vector3::new(0.0, 0.0, 1.0);
        let norm = forward.norm();
        let direction = if norm > 0.0 {
            forward / norm
        } else {
            Vector3::new(0.0, 0.0, 1.0)
        };
        let yaw_rad = direction.x.atan2(direction.z);
        let pitch_rad = direction.y.clamp(-1.0, 1.0).asin();
        Self::new(yaw_rad, pitch_rad, focal_px, image_size)
    }
}

/// Knobs for bounded overlap-graph construction.
#[derive(Debug, Clone)]
pub struct OverlapGraphOptions {
    /// Pitch tolerance used to cluster input poses into horizontal rows.
    pub row_pitch_tolerance_rad: f64,
    /// Maximum same-row adjacent yaw gap to consider a horizontal overlap.
    pub max_horizontal_yaw_gap_rad: f64,
    /// Maximum yaw mismatch for vertical nearest-row links.
    pub max_vertical_yaw_gap_rad: f64,
    /// Maximum pitch gap for vertical nearest-row links.
    pub max_vertical_pitch_gap_rad: f64,
    /// Emit one-image skip links within each row.
    pub enable_skip_neighbors: bool,
    /// Maximum yaw gap for skip links.
    pub max_skip_yaw_gap_rad: f64,
    /// Emit first/last links when a row wraps around 360 degrees.
    pub enable_loop_candidates: bool,
    /// Maximum wrapped yaw gap for loop links.
    pub max_loop_yaw_gap_rad: f64,
    /// Minimum row length before considering a loop link.
    pub min_loop_row_len: usize,
    /// Minimum intrinsics-derived overlap estimate for any candidate.
    pub min_estimated_overlap: f64,
}

impl Default for OverlapGraphOptions {
    fn default() -> Self {
        Self {
            row_pitch_tolerance_rad: degrees_to_radians(5.0),
            max_horizontal_yaw_gap_rad: degrees_to_radians(35.0),
            max_vertical_yaw_gap_rad: degrees_to_radians(8.0),
            max_vertical_pitch_gap_rad: degrees_to_radians(35.0),
            enable_skip_neighbors: false,
            max_skip_yaw_gap_rad: degrees_to_radians(70.0),
            enable_loop_candidates: true,
            max_loop_yaw_gap_rad: degrees_to_radians(35.0),
            min_loop_row_len: 4,
            min_estimated_overlap: 0.10,
        }
    }
}

/// Candidate list plus graph-connectivity diagnostics.
#[derive(Debug, Clone, PartialEq)]
pub struct OverlapGraphReport {
    pub pose_count: usize,
    pub row_count: usize,
    pub candidates: Vec<PairCandidate>,
    pub is_connected: bool,
    pub component_count: usize,
    pub largest_component_size: usize,
    pub isolated_pose_indices: Vec<usize>,
    pub connected_components: Vec<Vec<usize>>,
}

/// Build an overlap graph from compact pose summaries.
pub fn build_overlap_graph(
    poses: &[PoseSummary],
    options: &OverlapGraphOptions,
) -> OverlapGraphReport {
    let rows = group_rows(poses, finite_non_negative(options.row_pitch_tolerance_rad));
    let mut candidates = Vec::new();
    let mut seen_pairs = HashSet::new();

    add_horizontal_candidates(poses, &rows, options, &mut seen_pairs, &mut candidates);
    add_vertical_candidates(poses, &rows, options, &mut seen_pairs, &mut candidates);
    add_skip_candidates(poses, &rows, options, &mut seen_pairs, &mut candidates);
    add_loop_candidates(poses, &rows, options, &mut seen_pairs, &mut candidates);

    let (connected_components, isolated_pose_indices) =
        connectivity_diagnostics(poses.len(), &candidates);
    let largest_component_size = connected_components.iter().map(Vec::len).max().unwrap_or(0);
    let component_count = connected_components.len();
    let is_connected = component_count <= 1;

    OverlapGraphReport {
        pose_count: poses.len(),
        row_count: rows.len(),
        candidates,
        is_connected,
        component_count,
        largest_component_size,
        isolated_pose_indices,
        connected_components,
    }
}

/// Build an overlap graph from per-image rotations, focal lengths, and sizes.
///
/// `focals_px` and `image_sizes` may either contain one value shared by every
/// rotation, or exactly one value per rotation.
pub fn build_overlap_graph_from_rotations(
    rotations: &[Matrix3<f64>],
    focals_px: &[f64],
    image_sizes: &[(u32, u32)],
    options: &OverlapGraphOptions,
) -> Result<OverlapGraphReport, PanoError> {
    if rotations.is_empty() {
        return Ok(build_overlap_graph(&[], options));
    }
    if focals_px.len() != 1 && focals_px.len() != rotations.len() {
        return Err(PanoError::Other(format!(
            "focal count must be 1 or {}, got {}",
            rotations.len(),
            focals_px.len()
        )));
    }
    if image_sizes.len() != 1 && image_sizes.len() != rotations.len() {
        return Err(PanoError::Other(format!(
            "image size count must be 1 or {}, got {}",
            rotations.len(),
            image_sizes.len()
        )));
    }

    let poses: Vec<PoseSummary> = rotations
        .iter()
        .enumerate()
        .map(|(idx, rotation)| {
            let focal_px = if focals_px.len() == 1 {
                focals_px[0]
            } else {
                focals_px[idx]
            };
            let image_size = if image_sizes.len() == 1 {
                image_sizes[0]
            } else {
                image_sizes[idx]
            };
            PoseSummary::from_rotation(rotation, focal_px, image_size)
        })
        .collect();

    Ok(build_overlap_graph(&poses, options))
}

#[derive(Debug, Clone)]
struct PoseRow {
    indices: Vec<usize>,
    mean_pitch_rad: f64,
}

fn add_horizontal_candidates(
    poses: &[PoseSummary],
    rows: &[PoseRow],
    options: &OverlapGraphOptions,
    seen_pairs: &mut HashSet<(usize, usize)>,
    candidates: &mut Vec<PairCandidate>,
) {
    let max_gap = finite_non_negative(options.max_horizontal_yaw_gap_rad);
    for row in rows {
        for pair in row.indices.windows(2) {
            let a = pair[0];
            let b = pair[1];
            let gap = sorted_yaw_gap(poses[a].yaw_rad, poses[b].yaw_rad);
            if gap <= max_gap {
                push_candidate(
                    poses,
                    a,
                    b,
                    PairCandidateReason::Horizontal,
                    options,
                    seen_pairs,
                    candidates,
                );
            }
        }
    }
}

fn add_vertical_candidates(
    poses: &[PoseSummary],
    rows: &[PoseRow],
    options: &OverlapGraphOptions,
    seen_pairs: &mut HashSet<(usize, usize)>,
    candidates: &mut Vec<PairCandidate>,
) {
    let max_yaw_gap = finite_non_negative(options.max_vertical_yaw_gap_rad);
    let max_pitch_gap = finite_non_negative(options.max_vertical_pitch_gap_rad);

    for row_pair in rows.windows(2) {
        let lower = &row_pair[0];
        let upper = &row_pair[1];
        add_nearest_vertical_links(
            poses,
            lower,
            upper,
            max_yaw_gap,
            max_pitch_gap,
            options,
            seen_pairs,
            candidates,
        );
        add_nearest_vertical_links(
            poses,
            upper,
            lower,
            max_yaw_gap,
            max_pitch_gap,
            options,
            seen_pairs,
            candidates,
        );
    }
}

fn add_nearest_vertical_links(
    poses: &[PoseSummary],
    from_row: &PoseRow,
    to_row: &PoseRow,
    max_yaw_gap: f64,
    max_pitch_gap: f64,
    options: &OverlapGraphOptions,
    seen_pairs: &mut HashSet<(usize, usize)>,
    candidates: &mut Vec<PairCandidate>,
) {
    for &a in &from_row.indices {
        let best = to_row.indices.iter().copied().min_by(|&left, &right| {
            yaw_delta_abs(poses[a].yaw_rad, poses[left].yaw_rad)
                .total_cmp(&yaw_delta_abs(poses[a].yaw_rad, poses[right].yaw_rad))
        });

        let Some(b) = best else {
            continue;
        };

        let yaw_gap = yaw_delta_abs(poses[a].yaw_rad, poses[b].yaw_rad);
        let pitch_gap = (poses[a].pitch_rad - poses[b].pitch_rad).abs();
        if yaw_gap <= max_yaw_gap && pitch_gap <= max_pitch_gap {
            push_candidate(
                poses,
                a,
                b,
                PairCandidateReason::Vertical,
                options,
                seen_pairs,
                candidates,
            );
        }
    }
}

fn add_skip_candidates(
    poses: &[PoseSummary],
    rows: &[PoseRow],
    options: &OverlapGraphOptions,
    seen_pairs: &mut HashSet<(usize, usize)>,
    candidates: &mut Vec<PairCandidate>,
) {
    if !options.enable_skip_neighbors {
        return;
    }

    let max_gap = finite_non_negative(options.max_skip_yaw_gap_rad);
    for row in rows {
        for idx in 0..row.indices.len().saturating_sub(2) {
            let a = row.indices[idx];
            let b = row.indices[idx + 2];
            let gap = sorted_yaw_gap(poses[a].yaw_rad, poses[b].yaw_rad);
            if gap <= max_gap {
                push_candidate(
                    poses,
                    a,
                    b,
                    PairCandidateReason::Skip,
                    options,
                    seen_pairs,
                    candidates,
                );
            }
        }
    }
}

fn add_loop_candidates(
    poses: &[PoseSummary],
    rows: &[PoseRow],
    options: &OverlapGraphOptions,
    seen_pairs: &mut HashSet<(usize, usize)>,
    candidates: &mut Vec<PairCandidate>,
) {
    if !options.enable_loop_candidates {
        return;
    }

    let max_gap = finite_non_negative(options.max_loop_yaw_gap_rad);
    let min_row_len = options.min_loop_row_len.max(2);
    for row in rows {
        if row.indices.len() < min_row_len {
            continue;
        }

        let first = row.indices[0];
        let last = row.indices[row.indices.len() - 1];
        let gap = loop_yaw_gap(poses[first].yaw_rad, poses[last].yaw_rad);
        if gap <= max_gap {
            push_candidate(
                poses,
                first,
                last,
                PairCandidateReason::Loop,
                options,
                seen_pairs,
                candidates,
            );
        }
    }
}

fn push_candidate(
    poses: &[PoseSummary],
    a: usize,
    b: usize,
    reason: PairCandidateReason,
    options: &OverlapGraphOptions,
    seen_pairs: &mut HashSet<(usize, usize)>,
    candidates: &mut Vec<PairCandidate>,
) {
    if a == b {
        return;
    }
    let key = ordered_pair(a, b);
    if seen_pairs.contains(&key) {
        return;
    }

    let candidate = make_candidate(poses, key.0, key.1, reason);
    if candidate.estimated_overlap < options.min_estimated_overlap.clamp(0.0, 1.0) {
        return;
    }

    seen_pairs.insert(key);
    candidates.push(candidate);
}

fn make_candidate(
    poses: &[PoseSummary],
    a: usize,
    b: usize,
    reason: PairCandidateReason,
) -> PairCandidate {
    let pose_a = poses[a];
    let pose_b = poses[b];
    let yaw_delta_rad = yaw_delta_abs(pose_a.yaw_rad, pose_b.yaw_rad);
    let pitch_delta_rad = (pose_a.pitch_rad - pose_b.pitch_rad).abs();
    PairCandidate {
        a,
        b,
        reason,
        yaw_delta_rad,
        pitch_delta_rad,
        angular_distance_rad: angular_distance(&pose_a, &pose_b),
        estimated_overlap: estimate_overlap(&pose_a, &pose_b),
    }
}

fn group_rows(poses: &[PoseSummary], row_pitch_tolerance_rad: f64) -> Vec<PoseRow> {
    let mut order: Vec<usize> = (0..poses.len()).collect();
    order.sort_by(|&a, &b| {
        poses[a]
            .pitch_rad
            .total_cmp(&poses[b].pitch_rad)
            .then_with(|| {
                normalized_angle_rad(poses[a].yaw_rad)
                    .total_cmp(&normalized_angle_rad(poses[b].yaw_rad))
            })
            .then_with(|| a.cmp(&b))
    });

    let mut rows: Vec<PoseRow> = Vec::new();
    for idx in order {
        let pitch = poses[idx].pitch_rad;
        if let Some(row) = rows.last_mut() {
            if (pitch - row.mean_pitch_rad).abs() <= row_pitch_tolerance_rad {
                let len = row.indices.len() as f64;
                row.mean_pitch_rad = (row.mean_pitch_rad * len + pitch) / (len + 1.0);
                row.indices.push(idx);
                continue;
            }
        }
        rows.push(PoseRow {
            indices: vec![idx],
            mean_pitch_rad: pitch,
        });
    }

    for row in &mut rows {
        row.indices.sort_by(|&a, &b| {
            normalized_angle_rad(poses[a].yaw_rad)
                .total_cmp(&normalized_angle_rad(poses[b].yaw_rad))
                .then_with(|| a.cmp(&b))
        });
    }

    rows
}

fn connectivity_diagnostics(
    pose_count: usize,
    candidates: &[PairCandidate],
) -> (Vec<Vec<usize>>, Vec<usize>) {
    if pose_count == 0 {
        return (Vec::new(), Vec::new());
    }

    let mut adjacency = vec![Vec::<usize>::new(); pose_count];
    for candidate in candidates {
        if candidate.a < pose_count && candidate.b < pose_count {
            adjacency[candidate.a].push(candidate.b);
            adjacency[candidate.b].push(candidate.a);
        }
    }

    let isolated_pose_indices = adjacency
        .iter()
        .enumerate()
        .filter_map(|(idx, neighbors)| neighbors.is_empty().then_some(idx))
        .collect();

    let mut seen = vec![false; pose_count];
    let mut components = Vec::new();
    for start in 0..pose_count {
        if seen[start] {
            continue;
        }
        let mut queue = VecDeque::from([start]);
        seen[start] = true;
        let mut component = Vec::new();

        while let Some(idx) = queue.pop_front() {
            component.push(idx);
            for &next in &adjacency[idx] {
                if !seen[next] {
                    seen[next] = true;
                    queue.push_back(next);
                }
            }
        }

        component.sort_unstable();
        components.push(component);
    }

    components.sort_by(|a, b| a[0].cmp(&b[0]));
    (components, isolated_pose_indices)
}

fn estimate_overlap(a: &PoseSummary, b: &PoseSummary) -> f64 {
    let horizontal = overlap_along_axis(
        yaw_delta_abs(a.yaw_rad, b.yaw_rad),
        average_fov(horizontal_fov_rad(a), horizontal_fov_rad(b)),
    );
    let vertical = overlap_along_axis(
        (a.pitch_rad - b.pitch_rad).abs(),
        average_fov(vertical_fov_rad(a), vertical_fov_rad(b)),
    );
    (horizontal * vertical).clamp(0.0, 1.0)
}

fn overlap_along_axis(delta_rad: f64, fov_rad: f64) -> f64 {
    if fov_rad <= 0.0 || !fov_rad.is_finite() {
        return 0.0;
    }
    (1.0 - delta_rad / fov_rad).clamp(0.0, 1.0)
}

fn horizontal_fov_rad(pose: &PoseSummary) -> f64 {
    fov_rad(pose.image_size.0, pose.focal_px, DEFAULT_HORIZONTAL_FOV_RAD)
}

fn vertical_fov_rad(pose: &PoseSummary) -> f64 {
    fov_rad(pose.image_size.1, pose.focal_px, DEFAULT_VERTICAL_FOV_RAD)
}

fn fov_rad(pixels: u32, focal_px: f64, fallback: f64) -> f64 {
    if pixels == 0 || focal_px <= 0.0 || !focal_px.is_finite() {
        return fallback;
    }
    2.0 * ((pixels as f64) / (2.0 * focal_px)).atan()
}

fn average_fov(a: f64, b: f64) -> f64 {
    ((a + b) * 0.5).clamp(0.0, std::f64::consts::PI)
}

fn angular_distance(a: &PoseSummary, b: &PoseSummary) -> f64 {
    let da = direction_from_yaw_pitch(a.yaw_rad, a.pitch_rad);
    let db = direction_from_yaw_pitch(b.yaw_rad, b.pitch_rad);
    da.dot(&db).clamp(-1.0, 1.0).acos()
}

fn direction_from_yaw_pitch(yaw_rad: f64, pitch_rad: f64) -> Vector3<f64> {
    let cos_pitch = pitch_rad.cos();
    Vector3::new(
        cos_pitch * yaw_rad.sin(),
        pitch_rad.sin(),
        cos_pitch * yaw_rad.cos(),
    )
}

fn ordered_pair(a: usize, b: usize) -> (usize, usize) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

fn sorted_yaw_gap(left_yaw_rad: f64, right_yaw_rad: f64) -> f64 {
    normalized_angle_rad(right_yaw_rad) - normalized_angle_rad(left_yaw_rad)
}

fn loop_yaw_gap(first_yaw_rad: f64, last_yaw_rad: f64) -> f64 {
    TWO_PI - sorted_yaw_gap(first_yaw_rad, last_yaw_rad)
}

fn yaw_delta_abs(a: f64, b: f64) -> f64 {
    normalized_angle_rad(a - b).abs()
}

fn normalized_angle_rad(angle_rad: f64) -> f64 {
    (angle_rad + std::f64::consts::PI).rem_euclid(TWO_PI) - std::f64::consts::PI
}

fn finite_non_negative(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        0.0
    }
}

fn degrees_to_radians(degrees: f64) -> f64 {
    degrees * std::f64::consts::PI / 180.0
}

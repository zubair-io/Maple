//! Up-vector correction (spec §5.3): one global rotation, applied after
//! the bundle adjustment, that levels the horizon — the fix for the
//! "banana" artifact in long strips.
//!
//! # Model
//!
//! Under a leveled pano sweep the cameras' **x-axes** (image "right",
//! world coordinates) all lie in the horizontal plane: yaw spins them
//! around the up direction and pitch tilts only the y/z axes. So the up
//! direction is the normal of the plane best spanned by the solved
//! x-axes — the least-eigenvalue eigenvector of the scatter
//! `S = Σ x̂ᵢ x̂ᵢᵀ`. A camera's roll lifts its x-axis out of the plane by
//! exactly the roll angle, so per-camera roll that is *uncorrelated with
//! yaw* averages out of the normal estimate, while yaw-correlated roll
//! biases it linearly. Drone gimbals hold roll near zero — that is the
//! regime the spec's 0.3° horizon gate is defined for.
//!
//! The sign of the normal is disambiguated with the mean camera-up
//! direction (`R·(0,−1,0)` — camera frame is +Y **down**), and the
//! correction is the minimal rotation taking the normal onto world up.
//! World up is `−Y`: the identity pose maps camera axes onto world axes,
//! so the world frame inherits the y-down convention (the same one the
//! ground-truth renderer's yaw/pitch pattern is built in).
//!
//! Gauge only: [`BaSolution::apply_global_rotation`] rotates every
//! camera by the same `g`, so relative geometry and every residual
//! statistic are untouched.

use crate::ba::BaSolution;
use crate::eigen::eigen_symmetric;
use crate::math::{axis_angle_to_matrix, Mat3, Vec3};

/// World up direction (−Y; see module docs).
const WORLD_UP: Vec3 = Vec3 {
    x: 0.0,
    y: -1.0,
    z: 0.0,
};

/// Minimum relative gap between the two smallest eigenvalues of the
/// x-axis scatter for the horizontal plane to count as observable.
/// Below this (e.g. two cameras with parallel x-axes) the normal
/// direction is arbitrary within a subspace and leveling must not
/// invent one.
const MIN_RELATIVE_EIGEN_GAP: f64 = 1e-9;

/// The leveling rotation for a solved camera set, or `None` when it is
/// unobservable (fewer than two solved cameras, or degenerate x-axis
/// scatter — see [`MIN_RELATIVE_EIGEN_GAP`]).
pub fn leveling_rotation(solution: &BaSolution) -> Option<Mat3> {
    let mut scatter = [[0.0_f64; 3]; 3];
    let mut up_sum = Vec3 {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };
    let mut count = 0_usize;
    for cam in solution.cameras.iter().flatten() {
        let x = cam.rotation.mul_vec(Vec3 {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
        let x = x.normalized()?; // rotation columns are unit by construction
        let arr = [x.x, x.y, x.z];
        for (i, row) in scatter.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                *cell += arr[i] * arr[j];
            }
        }
        // Camera up in world coordinates (camera +Y is down).
        let up = cam.rotation.mul_vec(Vec3 {
            x: 0.0,
            y: -1.0,
            z: 0.0,
        });
        up_sum = Vec3 {
            x: up_sum.x + up.x,
            y: up_sum.y + up.y,
            z: up_sum.z + up.z,
        };
        count += 1;
    }
    if count < 2 {
        return None;
    }

    let (vals, vecs) = eigen_symmetric(&scatter); // descending
    if vals[0] <= 0.0 || (vals[1] - vals[2]) / vals[0] < MIN_RELATIVE_EIGEN_GAP {
        return None;
    }
    let mut normal = Vec3 {
        x: vecs[2][0],
        y: vecs[2][1],
        z: vecs[2][2],
    };
    if normal.dot(up_sum) < 0.0 {
        normal = normal.scale(-1.0);
    }
    Some(rotation_between(normal, WORLD_UP))
}

/// Solve and apply the leveling rotation in place. Returns `false`
/// (solution untouched) when leveling is unobservable.
pub fn apply(solution: &mut BaSolution) -> bool {
    match leveling_rotation(solution) {
        Some(g) => {
            solution.apply_global_rotation(&g);
            true
        }
        None => false,
    }
}

/// The spec §7 horizon metric: the largest tilt of any solved camera's
/// x-axis out of the horizontal plane, in degrees.
pub fn horizon_tilt_deg(solution: &BaSolution) -> f64 {
    let mut worst = 0.0_f64;
    for cam in solution.cameras.iter().flatten() {
        let x = cam.rotation.mul_vec(Vec3 {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
        worst = worst.max(x.dot(WORLD_UP).abs().asin().to_degrees());
    }
    worst
}

/// Minimal rotation taking unit vector `from` onto unit vector `to`
/// (Rodrigues). Antipodal inputs rotate 180° around an arbitrary axis
/// perpendicular to `from`.
fn rotation_between(from: Vec3, to: Vec3) -> Mat3 {
    let axis = from.cross(to);
    let sin = axis.norm();
    let cos = from.dot(to);
    if sin < 1e-15 {
        if cos > 0.0 {
            return Mat3::identity();
        }
        // Antipodal: any perpendicular axis works; build one from the
        // basis vector least aligned with `from`.
        let seed = if from.x.abs() < 0.9 {
            Vec3 {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            }
        } else {
            Vec3 {
                x: 0.0,
                y: 1.0,
                z: 0.0,
            }
        };
        let perp = from
            .cross(seed)
            .normalized()
            .expect("seed chosen non-parallel");
        return axis_angle_to_matrix([
            perp.x * std::f64::consts::PI,
            perp.y * std::f64::consts::PI,
            perp.z * std::f64::consts::PI,
        ]);
    }
    let angle = sin.atan2(cos);
    let unit = axis.scale(1.0 / sin);
    axis_angle_to_matrix([unit.x * angle, unit.y * angle, unit.z * angle])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::Camera;
    use crate::math::matrix_to_axis_angle;

    fn solution_from_rotations(rotations: &[Mat3]) -> BaSolution {
        BaSolution {
            cameras: rotations
                .iter()
                .map(|r| {
                    Some(Camera::new(
                        matrix_to_axis_angle(r),
                        800.0,
                        0.0,
                        0.0,
                        640,
                        480,
                    ))
                })
                .collect(),
            shared_focal_px: 800.0,
            k1: 0.0,
            k2: 0.0,
            frame_stats: vec![None; rotations.len()],
            dropped: Vec::new(),
            mean_reproj_px: 0.0,
            max_reproj_px: 0.0,
            mean_reproj_before_local_px: 0.0,
            max_reproj_before_local_px: 0.0,
            lm_iterations: 0,
            final_cost: 0.0,
            converged: true,
            solve_rounds: 1,
            pruned_matches: 0,
            motion_affected: Vec::new(),
            motion_pruned_matches: Vec::new(),
            local_corrections: vec![None; rotations.len()],
            local_correction_rms: vec![0.0; rotations.len()],
            placed_by_prior: Vec::new(),
        }
    }

    /// A leveled ring stays put: g ≈ identity.
    #[test]
    fn leveled_ring_is_fixed_point() {
        let rots: Vec<Mat3> = (0..6)
            .map(|i| Mat3::rotation_y(i as f64 * std::f64::consts::TAU / 6.0))
            .collect();
        let solution = solution_from_rotations(&rots);
        assert!(horizon_tilt_deg(&solution) < 1e-9);
        let g = leveling_rotation(&solution).expect("observable");
        assert!(g.max_abs_diff(&Mat3::identity()) < 1e-9);
    }

    /// A ring tilted by a known global rotation levels back to < 1e-6°.
    #[test]
    fn tilted_ring_levels_back() {
        let tilt =
            Mat3::rotation_z(7.0_f64.to_radians()).mul_mat(&Mat3::rotation_x(4.0_f64.to_radians()));
        let rots: Vec<Mat3> = (0..8)
            .map(|i| tilt.mul_mat(&Mat3::rotation_y(i as f64 * std::f64::consts::TAU / 8.0)))
            .collect();
        let mut solution = solution_from_rotations(&rots);
        assert!(horizon_tilt_deg(&solution) > 3.0);
        assert!(apply(&mut solution));
        assert!(
            horizon_tilt_deg(&solution) < 1e-6,
            "residual tilt {}°",
            horizon_tilt_deg(&solution)
        );
    }

    /// Two cameras sharing a yaw axis: x-axes parallel, plane
    /// unobservable — leveling must decline, not invent.
    #[test]
    fn parallel_x_axes_decline() {
        let rots = vec![Mat3::identity(), Mat3::rotation_x(0.3)];
        let solution = solution_from_rotations(&rots);
        assert!(leveling_rotation(&solution).is_none());
    }

    /// Roll that is uncorrelated with yaw cancels out of the plane
    /// estimate (see module docs): alternating ±2° rolls around a tilted
    /// ring leave the recovered global rotation within 0.2° of the true
    /// tilt. (Yaw-*correlated* roll would bias the normal linearly —
    /// the gimbal regime the 0.3° gate assumes has near-zero roll.)
    #[test]
    fn uncorrelated_roll_cancels() {
        let tilt = Mat3::rotation_x(5.0_f64.to_radians());
        let rots: Vec<Mat3> = (0..10)
            .map(|i| {
                let roll = if i % 2 == 0 { 2.0_f64 } else { -2.0_f64 }.to_radians();
                tilt.mul_mat(&Mat3::rotation_y(i as f64 * std::f64::consts::TAU / 10.0))
                    .mul_mat(&Mat3::rotation_z(roll))
            })
            .collect();
        let solution = solution_from_rotations(&rots);
        let g = leveling_rotation(&solution).expect("observable");
        let residual = g.mul_mat(&tilt);
        let omega = matrix_to_axis_angle(&residual);
        let angle_deg = (omega[0] * omega[0] + omega[1] * omega[1] + omega[2] * omega[2])
            .sqrt()
            .to_degrees();
        assert!(angle_deg < 0.2, "residual global tilt {angle_deg}°");
    }
}

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
//! # Roll only (#5958)
//!
//! The plane fit needs x-axes that point in clearly different
//! directions. A vertical pitch sweep has none: every camera pivots
//! about the same horizontal axis, so the x-axes are parallel, their
//! scatter is rank one, and any plane through that axis fits. Small
//! yaw jitter makes the fit numerically possible but meaningless — a
//! per-camera roll of σ tilts the fitted normal by about σ divided by
//! the x-axes' spread — so below [`MIN_HORIZON_SPREAD_DEG`] only the
//! roll is levelled: the mean x-axis `n = normalize(Σ x̂ᵢ)` is rotated
//! minimally onto its horizontal projection. That rotation's axis is
//! `n × n_h`, the horizontal direction perpendicular to `n`, i.e. the
//! sweep's forward axis: a pure roll. It keeps the heading of `n` (yaw)
//! and commutes with every camera's rotation about `n` (pitch); the
//! set's absolute pitch is unobservable from geometry and stays at the
//! solve's gauge (gimbal priors when present). Per-camera roll noise
//! averages down by `√N`, yaw jitter does not lift a level x-axis out of
//! the horizontal at all, and the angle is bounded by
//! [`MAX_ROLL_DEG`].
//!
//! Gauge only: [`BaSolution::apply_global_rotation`] rotates every
//! camera by the same `g`, so relative geometry and every residual
//! statistic are untouched.

use crate::ba::BaSolution;
use crate::camera::Camera;
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
/// Below this the x-axes fill a cone rather than a plane and the normal
/// direction is arbitrary within a subspace; leveling must not invent
/// one.
const MIN_RELATIVE_EIGEN_GAP: f64 = 1e-9;

/// RMS spread of the solved x-axes about their mean below which the
/// plane they span is not trusted and only the roll is levelled (see
/// module docs). 10° is two frames 20° apart in yaw, or a uniform yaw
/// sweep of about 35°.
const MIN_HORIZON_SPREAD_DEG: f64 = 10.0;

/// Largest roll the roll-only level removes. Past 45° the mean x-axis is
/// closer to vertical than horizontal, which a rolled landscape set and
/// a portrait set explain equally well, so the set is left as solved.
const MAX_ROLL_DEG: f64 = 45.0;

/// Which correction [`apply`] made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Leveling {
    /// The plane of the solved x-axes was made horizontal.
    Horizon,
    /// Only the mean x-axis was rotated into the horizontal plane.
    Roll,
}

impl Leveling {
    pub fn label(self) -> &'static str {
        match self {
            Leveling::Horizon => "horizon",
            Leveling::Roll => "roll",
        }
    }
}

/// The leveling rotation for a solved camera set and which correction it
/// is, or `None` when neither is observable (fewer than two solved
/// cameras, x-axes in a cone rather than a plane, or a roll past
/// [`MAX_ROLL_DEG`]).
pub fn leveling_rotation(solution: &BaSolution) -> Option<(Leveling, Mat3)> {
    let mut scatter = [[0.0_f64; 3]; 3];
    let mut x_sum = Vec3::new(0.0, 0.0, 0.0);
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
        x_sum = x_sum + x;
        count += 1;
    }
    if count < 2 {
        return None;
    }

    let (vals, vecs) = eigen_symmetric(&scatter); // descending
    if vals[0] <= 0.0 {
        return None;
    }
    if vals[1] < vals[0] * MIN_HORIZON_SPREAD_DEG.to_radians().tan().powi(2) {
        return roll_rotation(x_sum).map(|g| (Leveling::Roll, g));
    }
    if (vals[1] - vals[2]) / vals[0] < MIN_RELATIVE_EIGEN_GAP {
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
    Some((Leveling::Horizon, rotation_between(normal, WORLD_UP)))
}

/// The pure roll taking the mean x-axis onto its horizontal projection,
/// or `None` past [`MAX_ROLL_DEG`].
fn roll_rotation(x_sum: Vec3) -> Option<Mat3> {
    let mean = x_sum.normalized()?;
    let level = (mean - WORLD_UP.scale(mean.dot(WORLD_UP))).normalized()?;
    (mean.dot(level) >= MAX_ROLL_DEG.to_radians().cos()).then(|| rotation_between(mean, level))
}

/// Solve and apply the leveling rotation in place. Returns the
/// correction made, or `None` (solution untouched) when leveling is
/// unobservable.
pub fn apply(solution: &mut BaSolution) -> Option<Leveling> {
    let (leveling, g) = leveling_rotation(solution)?;
    solution.apply_global_rotation(&g);
    Some(leveling)
}

fn camera_tilt_deg(cam: &Camera) -> f64 {
    let x = cam.rotation.mul_vec(Vec3 {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    });
    x.dot(WORLD_UP).abs().min(1.0).asin().to_degrees()
}

/// The spec §7 horizon metric: the largest tilt of any solved camera's
/// x-axis out of the horizontal plane, in degrees.
pub fn horizon_tilt_deg(solution: &BaSolution) -> f64 {
    solution
        .cameras
        .iter()
        .flatten()
        .map(camera_tilt_deg)
        .fold(0.0_f64, f64::max)
}

pub fn horizon_tilt_rms_deg(solution: &BaSolution) -> f64 {
    let (mut sum_sq, mut n) = (0.0_f64, 0_usize);
    for cam in solution.cameras.iter().flatten() {
        let t = camera_tilt_deg(cam);
        sum_sq += t * t;
        n += 1;
    }
    if n == 0 {
        0.0
    } else {
        (sum_sq / n as f64).sqrt()
    }
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

    #[test]
    fn a_camera_rolled_onto_the_vertical_reports_a_finite_tilt() {
        let rolls: Vec<Mat3> = (0..2000)
            .map(|i| {
                let tilt = std::f64::consts::FRAC_PI_2 + (i as f64 - 1000.0) * 1e-17;
                let yaw = i as f64 * 0.37;
                Mat3::rotation_y(yaw).mul_mat(&Mat3::rotation_z(-tilt))
            })
            .collect();
        let solution = solution_from_rotations(&rolls);
        let tilt = horizon_tilt_deg(&solution);
        let rms = horizon_tilt_rms_deg(&solution);
        assert!((tilt - 90.0).abs() < 1e-6, "max tilt {tilt}");
        assert!((rms - 90.0).abs() < 1e-6, "rms tilt {rms}");
    }

    /// A leveled ring stays put: g ≈ identity.
    #[test]
    fn leveled_ring_is_fixed_point() {
        let rots: Vec<Mat3> = (0..6)
            .map(|i| Mat3::rotation_y(i as f64 * std::f64::consts::TAU / 6.0))
            .collect();
        let solution = solution_from_rotations(&rots);
        assert!(horizon_tilt_deg(&solution) < 1e-9);
        let (kind, g) = leveling_rotation(&solution).expect("observable");
        assert_eq!(kind, Leveling::Horizon);
        assert!(g.max_abs_diff(&Mat3::identity()) < 1e-9);
    }

    #[test]
    fn rms_tilt_ignores_single_outlier_pose() {
        let mut rots: Vec<Mat3> = (0..8)
            .map(|i| Mat3::rotation_y(i as f64 * std::f64::consts::TAU / 8.0))
            .collect();
        rots[0] = rots[0].mul_mat(&Mat3::rotation_z(4.0_f64.to_radians()));
        let solution = solution_from_rotations(&rots);
        let worst = horizon_tilt_deg(&solution);
        let rms = horizon_tilt_rms_deg(&solution);
        assert!(worst > 3.0, "worst {worst}");
        assert!(rms < worst / 2.0, "rms {rms} vs worst {worst}");
        assert!(rms > 0.5, "rms {rms} should still register the outlier");
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
        assert_eq!(apply(&mut solution), Some(Leveling::Horizon));
        assert!(
            horizon_tilt_deg(&solution) < 1e-6,
            "residual tilt {}°",
            horizon_tilt_deg(&solution)
        );
    }

    /// Two cameras sharing a pitch axis: x-axes parallel, the plane is
    /// unobservable but the roll is not — and it is already zero.
    #[test]
    fn parallel_level_x_axes_get_an_identity_roll() {
        let rots = vec![Mat3::identity(), Mat3::rotation_x(0.3)];
        let solution = solution_from_rotations(&rots);
        let (kind, g) = leveling_rotation(&solution).expect("roll observable");
        assert_eq!(kind, Leveling::Roll);
        assert!(g.max_abs_diff(&Mat3::identity()) < 1e-12);
    }

    /// `Ry(ψ)·Rz(ρ)·Rx(θᵢ)`: a pitch sweep heading `ψ`, leaned by `ρ`
    /// about its horizontal forward axis, with per-camera yaw jitter and
    /// roll noise.
    fn leaned_sweep(
        heading_deg: f64,
        lean_deg: f64,
        pitches_deg: &[f64],
        noise: bool,
    ) -> Vec<Mat3> {
        let lean = Mat3::rotation_y(heading_deg.to_radians())
            .mul_mat(&Mat3::rotation_z(lean_deg.to_radians()))
            .mul_mat(&Mat3::rotation_y(-heading_deg.to_radians()));
        pitches_deg
            .iter()
            .enumerate()
            .map(|(i, pitch)| {
                let sign = if i % 2 == 0 { 1.0 } else { -1.0 };
                let (yaw_jitter, roll) = if noise {
                    (2.0 * sign, -0.3 * sign)
                } else {
                    (0.0, 0.0)
                };
                lean.mul_mat(&Mat3::rotation_y((heading_deg + yaw_jitter).to_radians()))
                    .mul_mat(&Mat3::rotation_x(pitch.to_radians()))
                    .mul_mat(&Mat3::rotation_z(roll.to_radians()))
            })
            .collect()
    }

    fn angle_deg(r: &Mat3) -> f64 {
        let w = matrix_to_axis_angle(r);
        (w[0] * w[0] + w[1] * w[1] + w[2] * w[2])
            .sqrt()
            .to_degrees()
    }

    const OVER_THE_ZENITH: [f64; 6] = [-10.0, 30.0, 70.0, 110.0, 150.0, 190.0];

    /// A pitch sweep over the zenith, leaned 7°: the roll-only level
    /// returns exactly the un-leaned poses, so yaw and every pitch are
    /// untouched, and levelling again is the identity.
    #[test]
    fn zenith_sweep_levels_only_its_roll() {
        let truth = leaned_sweep(35.0, 0.0, &OVER_THE_ZENITH, false);
        let mut solution =
            solution_from_rotations(&leaned_sweep(35.0, 7.0, &OVER_THE_ZENITH, false));
        assert!(horizon_tilt_deg(&solution) > 6.9);
        let (kind, g) = leveling_rotation(&solution).expect("roll observable");
        assert_eq!(kind, Leveling::Roll);
        assert!(
            (angle_deg(&g) - 7.0).abs() < 1e-9,
            "roll {}°",
            angle_deg(&g)
        );
        assert_eq!(apply(&mut solution), Some(Leveling::Roll));
        for (cam, want) in solution.cameras.iter().flatten().zip(&truth) {
            assert!(cam.rotation.max_abs_diff(want) < 1e-9);
        }
        let (_, again) = leveling_rotation(&solution).expect("still observable");
        assert!(again.max_abs_diff(&Mat3::identity()) < 1e-12);
    }

    /// Yaw jitter of ±2° and roll noise of ±0.3° keep the x-axes far
    /// below the plane-fit spread; the recovered lean stays within 0.1°.
    #[test]
    fn noisy_pitch_sweep_recovers_its_lean() {
        let lean = Mat3::rotation_y(-20f64.to_radians())
            .mul_mat(&Mat3::rotation_z(5f64.to_radians()))
            .mul_mat(&Mat3::rotation_y(20f64.to_radians()));
        let rots = leaned_sweep(-20.0, 5.0, &OVER_THE_ZENITH, true);
        let (kind, g) = leveling_rotation(&solution_from_rotations(&rots)).expect("observable");
        assert_eq!(kind, Leveling::Roll);
        let residual = angle_deg(&g.mul_mat(&lean));
        assert!(residual < 0.1, "residual lean {residual}°");
    }

    #[test]
    fn roll_past_the_bound_is_refused() {
        let rots = leaned_sweep(0.0, 60.0, &OVER_THE_ZENITH, false);
        assert!(leveling_rotation(&solution_from_rotations(&rots)).is_none());
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
        let (kind, g) = leveling_rotation(&solution).expect("observable");
        assert_eq!(kind, Leveling::Horizon);
        let residual = g.mul_mat(&tilt);
        let omega = matrix_to_axis_angle(&residual);
        let angle_deg = (omega[0] * omega[0] + omega[1] * omega[1] + omega[2] * omega[2])
            .sqrt()
            .to_degrees();
        assert!(angle_deg < 0.2, "residual global tilt {angle_deg}°");
    }
}

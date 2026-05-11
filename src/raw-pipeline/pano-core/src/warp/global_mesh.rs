//! Coupled global mesh solve for per-image local-warp fields.
//!
//! Given:
//!   - N images, each warped onto the canvas with a global pose
//!     (rotation + focal + planar translation, output of joint BA).
//!   - A list of cross-image feature correspondences expressed in
//!     **canvas-pixel** coordinates: each match says "this physical
//!     feature lands at canvas pos `pa` under image i's projection
//!     and at canvas pos `pb` under image j's projection. After
//!     adding the per-image displacement field, those positions
//!     should agree."
//!
//! Produce: a `LocalWarpField` per image (default 9×9 vertices)
//! whose bilinear interpolation `D_i(p)` shifts image i's contribution
//! at canvas position `p` so that all matches' canvas-position
//! disagreements collapse to zero (in a least-squares sense).
//!
//! # Energy
//!
//! The solver minimises a sum of three losses, all in canvas pixels:
//!
//! **Alignment** (per match `(pa, pb)` between images i, j; per axis):
//! ```text
//!     r_align = (pa.x + D_i.x(pa)) − (pb.x + D_j.x(pb)) = 0
//!               same for y
//! ```
//! The mesh variables of BOTH images appear in the same residual
//! equation — that's what makes this a coupled global solve, not
//! pair-by-pair midpoint chasing. Each match contributes 8 sparse
//! non-zeros per axis (4 mesh vertices around `pa` for image i, plus
//! 4 around `pb` for image j).
//!
//! **Smoothness** (per pair of mesh-adjacent vertices in image i,
//! per axis):
//! ```text
//!     r_smooth = D_i(v_a) − D_i(v_b) = 0
//!     weight   = λ_smooth   (default 5.0)
//! ```
//! Encourages the mesh field to be spatially smooth — adjacent
//! vertices' displacements should be similar.
//!
//! **Zero / gauge prior** (per vertex, per axis):
//! ```text
//!     r_zero = D_i(v) = 0
//!     weight = λ_zero   (default 0.1)
//! ```
//! Pulls toward the no-op solution. Doubles as the gauge fix —
//! when a connected component of the match graph has rank-deficient
//! constraints, this prior selects the minimum-displacement
//! solution. It also prevents the solver from drifting unboundedly
//! when an image has very few matches.
//!
//! # System
//!
//! 2 × N × (mesh_cols × mesh_rows) unknowns. For N=21 with the
//! default 9×9 mesh, that's 2 × 21 × 81 = 3402 unknowns. The system
//! is sparse, well-conditioned (smoothness + zero priors guarantee
//! positive-definite normal equations), and solved via
//! `nalgebra::DMatrix::lu().solve()` on the dense normal-equations
//! form. With 3402 unknowns dense LU is still quick (< 1 s).

use nalgebra::{DMatrix, DVector};

use crate::error::PanoError;
use crate::warp::canvas::Canvas;
use crate::warp::local_mesh::{LocalWarpDisplacement, LocalWarpField, LocalWarpOptions};

/// One feature correspondence between two warped images, expressed
/// in canvas pixels under each image's global-pose projection.
///
/// Construct via `image_pixel_to_canvas` from each image's RANSAC
/// inliers. `image_a` and `image_b` are indices into the per-image
/// arrays; `pa` is the canvas position of the matched feature
/// under image_a's projection, `pb` under image_b's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MatchObservation {
    pub image_a: usize,
    pub image_b: usize,
    pub pa: (f32, f32),
    pub pb: (f32, f32),
    /// Per-match weight (e.g. RANSAC inlier confidence). Default 1.0.
    pub weight: f32,
}

impl MatchObservation {
    pub fn new(image_a: usize, image_b: usize, pa: (f32, f32), pb: (f32, f32)) -> Self {
        Self {
            image_a,
            image_b,
            pa,
            pb,
            weight: 1.0,
        }
    }
}

/// Solver options.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlobalMeshOptions {
    /// Mesh-cols × mesh-rows per image. Same convention as
    /// `LocalWarpOptions`.
    pub mesh: LocalWarpOptions,
    /// Smoothness weight `λ_smooth`. Larger → smoother (more
    /// regularised) field. Default 5.0.
    pub lambda_smooth: f32,
    /// Zero/gauge prior weight `λ_zero`. Larger → smaller mesh
    /// displacement (closer to no-op). Default 0.1.
    pub lambda_zero: f32,
}

impl Default for GlobalMeshOptions {
    fn default() -> Self {
        Self {
            mesh: LocalWarpOptions::default(),
            lambda_smooth: 5.0,
            lambda_zero: 0.1,
        }
    }
}

/// Solve the coupled global mesh system. Returns one
/// `LocalWarpField` per image.
///
/// `image_count` must include all referenced images (any image not
/// in the observation set will receive a no-op field — its mesh
/// is constrained only by the zero prior, which pulls it to zero
/// displacement).
pub fn solve_global_mesh(
    observations: &[MatchObservation],
    image_count: usize,
    canvas: &Canvas,
    options: GlobalMeshOptions,
) -> Result<Vec<LocalWarpField>, PanoError> {
    options.mesh.validate()?;
    if image_count == 0 {
        return Ok(Vec::new());
    }

    let mesh_cols = options.mesh.mesh_cols as usize;
    let mesh_rows = options.mesh.mesh_rows as usize;
    let verts_per_image = mesh_cols * mesh_rows;
    // Two unknowns per vertex (dx, dy) per image. Unknowns laid out as:
    //   [img0_dx_v0, img0_dx_v1, ..., img0_dx_vK, img0_dy_v0, ..., img0_dy_vK,
    //    img1_dx_v0, ...]
    let unknowns_per_image = 2 * verts_per_image;
    let n_unknowns = image_count * unknowns_per_image;

    // We solve normal equations A^T A x = A^T b explicitly. For the
    // mesh sizes we care about (3400 unknowns at N=21) the dense
    // form is fine and a lot simpler than wiring a sparse solver.
    let mut ata = DMatrix::<f64>::zeros(n_unknowns, n_unknowns);
    let mut atb = DVector::<f64>::zeros(n_unknowns);

    let dx_index = |image_index: usize, vertex_index: usize| -> usize {
        image_index * unknowns_per_image + vertex_index
    };
    let dy_index = |image_index: usize, vertex_index: usize| -> usize {
        image_index * unknowns_per_image + verts_per_image + vertex_index
    };

    // ---- Alignment residuals: one row per axis per match ----------
    //
    // For each match (pa in image_a, pb in image_b):
    //   r_align_x = (pa.x + sum_k(w_a[k] * dx_a[k]))
    //             - (pb.x + sum_k(w_b[k] * dx_b[k])) = 0
    //
    // Rearranged: sum_k(w_a[k] * dx_a[k]) - sum_k(w_b[k] * dx_b[k])
    //           = pb.x - pa.x.
    //
    // (Same for y.)
    //
    // Each match contributes 8 nonzeros per axis: 4 a-side vertex
    // weights with sign +, 4 b-side vertex weights with sign −.
    for obs in observations {
        if obs.image_a >= image_count || obs.image_b >= image_count || obs.image_a == obs.image_b {
            continue;
        }
        if !obs.pa.0.is_finite()
            || !obs.pa.1.is_finite()
            || !obs.pb.0.is_finite()
            || !obs.pb.1.is_finite()
        {
            continue;
        }

        // Bilinear-weight the 4 mesh vertices around each canvas
        // position. Returns `[(vertex_index, weight)]` of length 4.
        let weights_a = bilinear_vertex_weights(canvas, mesh_cols, mesh_rows, obs.pa);
        let weights_b = bilinear_vertex_weights(canvas, mesh_cols, mesh_rows, obs.pb);

        // Per-match alignment weight (squared — this is normal-eqs).
        let w = obs.weight as f64;
        let w2 = w * w;

        // Build sparse row entries (col, val) for the alignment
        // residual r_x = sum_a + (-sum_b) ; pa-pb is on the rhs
        // negated.
        let mut row_x: Vec<(usize, f64)> = Vec::with_capacity(8);
        let mut row_y: Vec<(usize, f64)> = Vec::with_capacity(8);
        for &(va, wa) in &weights_a {
            row_x.push((dx_index(obs.image_a, va), wa as f64));
            row_y.push((dy_index(obs.image_a, va), wa as f64));
        }
        for &(vb, wb) in &weights_b {
            row_x.push((dx_index(obs.image_b, vb), -(wb as f64)));
            row_y.push((dy_index(obs.image_b, vb), -(wb as f64)));
        }
        let rhs_x = (obs.pb.0 - obs.pa.0) as f64;
        let rhs_y = (obs.pb.1 - obs.pa.1) as f64;

        // Add row^T row to ATA, w2 weighted; row^T rhs to ATB.
        accumulate_normal_equation_row(&row_x, rhs_x, w2, &mut ata, &mut atb);
        accumulate_normal_equation_row(&row_y, rhs_y, w2, &mut ata, &mut atb);
    }

    // ---- Smoothness residuals: D(v_a) - D(v_b) = 0 ----------------
    //
    // For each image and each pair of adjacent vertices (4-conn:
    // right and down), add a pair of single-axis residuals.
    //
    // Each smoothness row has only 2 nonzeros: +1 at v_a, -1 at v_b.
    let smooth_w2 = (options.lambda_smooth as f64).powi(2);
    if smooth_w2 > 0.0 {
        for image_index in 0..image_count {
            for ty in 0..mesh_rows {
                for tx in 0..mesh_cols {
                    let v_idx = ty * mesh_cols + tx;
                    // Right neighbour.
                    if tx + 1 < mesh_cols {
                        let v_right = ty * mesh_cols + (tx + 1);
                        accumulate_normal_equation_row(
                            &[
                                (dx_index(image_index, v_idx), 1.0),
                                (dx_index(image_index, v_right), -1.0),
                            ],
                            0.0,
                            smooth_w2,
                            &mut ata,
                            &mut atb,
                        );
                        accumulate_normal_equation_row(
                            &[
                                (dy_index(image_index, v_idx), 1.0),
                                (dy_index(image_index, v_right), -1.0),
                            ],
                            0.0,
                            smooth_w2,
                            &mut ata,
                            &mut atb,
                        );
                    }
                    // Down neighbour.
                    if ty + 1 < mesh_rows {
                        let v_down = (ty + 1) * mesh_cols + tx;
                        accumulate_normal_equation_row(
                            &[
                                (dx_index(image_index, v_idx), 1.0),
                                (dx_index(image_index, v_down), -1.0),
                            ],
                            0.0,
                            smooth_w2,
                            &mut ata,
                            &mut atb,
                        );
                        accumulate_normal_equation_row(
                            &[
                                (dy_index(image_index, v_idx), 1.0),
                                (dy_index(image_index, v_down), -1.0),
                            ],
                            0.0,
                            smooth_w2,
                            &mut ata,
                            &mut atb,
                        );
                    }
                }
            }
        }
    }

    // ---- Zero/gauge prior: D(v) = 0 -------------------------------
    //
    // For each unknown, add λ_zero² to the diagonal. Doubles as
    // gauge fix (without it, an isolated connected component has
    // a 2-dof translation null space — adding it pulls each
    // component toward 0 displacement).
    let zero_w2 = (options.lambda_zero as f64).powi(2);
    if zero_w2 > 0.0 {
        for k in 0..n_unknowns {
            ata[(k, k)] += zero_w2;
        }
    }

    // ---- Solve normal equations ----------------------------------
    let lu = ata.lu();
    let solution = lu.solve(&atb).ok_or_else(|| {
        PanoError::Other("global_mesh: singular normal-equations matrix".into())
    })?;

    // ---- Unpack into per-image LocalWarpFields -------------------
    let mut fields = Vec::with_capacity(image_count);
    for image_index in 0..image_count {
        let mut displacements = Vec::with_capacity(verts_per_image);
        for v in 0..verts_per_image {
            let dx = solution[dx_index(image_index, v)] as f32;
            let dy = solution[dy_index(image_index, v)] as f32;
            displacements.push(LocalWarpDisplacement::new(dx, dy));
        }
        let field = LocalWarpField::from_vertices(
            canvas.width,
            canvas.height,
            options.mesh.mesh_cols,
            options.mesh.mesh_rows,
            displacements,
        )?;
        fields.push(field);
    }

    Ok(fields)
}

/// Compute the 4 mesh vertices around the canvas position `(px, py)`
/// and their bilinear-interpolation weights. Returns
/// `[(vertex_index, weight)]` of length 4.
///
/// Mesh vertices are at canvas positions
/// `(tx * (W-1) / (cols-1), ty * (H-1) / (rows-1))` — same
/// convention as `LocalWarpField::sample`.
fn bilinear_vertex_weights(
    canvas: &Canvas,
    mesh_cols: usize,
    mesh_rows: usize,
    pos: (f32, f32),
) -> [(usize, f32); 4] {
    let (px, py) = pos;
    let w = canvas.width.max(1) as f32 - 1.0;
    let h = canvas.height.max(1) as f32 - 1.0;
    let tx_f = (px / w).clamp(0.0, 1.0) * (mesh_cols as f32 - 1.0);
    let ty_f = (py / h).clamp(0.0, 1.0) * (mesh_rows as f32 - 1.0);
    let tx0 = tx_f.floor() as usize;
    let ty0 = ty_f.floor() as usize;
    let tx1 = (tx0 + 1).min(mesh_cols - 1);
    let ty1 = (ty0 + 1).min(mesh_rows - 1);
    let fx = tx_f - tx0 as f32;
    let fy = ty_f - ty0 as f32;
    let w00 = (1.0 - fx) * (1.0 - fy);
    let w10 = fx * (1.0 - fy);
    let w01 = (1.0 - fx) * fy;
    let w11 = fx * fy;
    [
        (ty0 * mesh_cols + tx0, w00),
        (ty0 * mesh_cols + tx1, w10),
        (ty1 * mesh_cols + tx0, w01),
        (ty1 * mesh_cols + tx1, w11),
    ]
}

/// Add `w² · row^T row` to `ata` and `w² · row^T rhs` to `atb`.
/// `row` is a sparse list of `(column, coefficient)` pairs.
fn accumulate_normal_equation_row(
    row: &[(usize, f64)],
    rhs: f64,
    weight_sq: f64,
    ata: &mut DMatrix<f64>,
    atb: &mut DVector<f64>,
) {
    if weight_sq <= 0.0 {
        return;
    }
    for &(c_i, v_i) in row {
        for &(c_j, v_j) in row {
            ata[(c_i, c_j)] += weight_sq * v_i * v_j;
        }
        atb[c_i] += weight_sq * v_i * rhs;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Projection;
    use crate::warp::canvas::CanvasParams;

    fn rectilinear_canvas(w: u32, h: u32) -> Canvas {
        Canvas {
            width: w,
            height: h,
            projection: Projection::Rectilinear,
            params: CanvasParams::Rectilinear {
                focal: 500.0,
                cx: w as f32 * 0.5,
                cy: h as f32 * 0.5,
            },
        }
    }

    /// Two images, image 1's matches sit at +5 px from image 0's.
    /// The solver should split the disagreement: with no zero prior
    /// this would be ill-defined (any (a, b) with `a − b = +5`
    /// works); with the zero prior pulling both toward the origin,
    /// the symmetric solution `a = +2.5, b = −2.5` (image 0's mesh
    /// shifts +2.5, image 1's shifts −2.5) is preferred.
    ///
    /// We assert the SUM of per-image displacements at the match
    /// site is approximately the gauge-symmetric split.
    #[test]
    fn known_translation_split_between_images() {
        let canvas = rectilinear_canvas(400, 300);
        let mesh = LocalWarpOptions {
            mesh_cols: 4,
            mesh_rows: 4,
            max_displacement_px: 256.0,
        };
        let opts = GlobalMeshOptions {
            mesh,
            lambda_smooth: 5.0,
            lambda_zero: 0.1,
        };
        let observations: Vec<MatchObservation> = (0..16)
            .map(|i| {
                let row = (i % 4) as f32;
                let col = (i / 4) as f32;
                let cx = 50.0 + col * 75.0;
                let cy = 50.0 + row * 60.0;
                MatchObservation::new(0, 1, (cx, cy), (cx + 5.0, cy))
            })
            .collect();
        let fields = solve_global_mesh(&observations, 2, &canvas, opts).expect("solve");
        // Sample at a match site (200, 150). Image 0's field should
        // push +x, image 1's field should push -x. Their sum should
        // be ≈ +5 (the disagreement we wanted to close).
        let s0 = fields[0].sample(200.0, 150.0).expect("sample");
        let s1 = fields[1].sample(200.0, 150.0).expect("sample");
        let sum = s0.dx - s1.dx; // image 0 pushes +x, image 1 pushes -x to meet
        assert!(
            (sum - 5.0).abs() < 1.0,
            "expected ~5 px split, got s0.dx={:.3} s1.dx={:.3} sum={:.3}",
            s0.dx, s1.dx, sum
        );
    }

    /// Empty observation set + zero prior → all fields are
    /// approximately zero.
    #[test]
    fn empty_observations_returns_zero_fields() {
        let canvas = rectilinear_canvas(400, 300);
        let opts = GlobalMeshOptions::default();
        let fields = solve_global_mesh(&[], 3, &canvas, opts).expect("solve");
        assert_eq!(fields.len(), 3);
        for field in &fields {
            for y in (0..300).step_by(50) {
                let s = field.sample(200.0, y as f32).expect("sample");
                assert!(s.dx.abs() < 1e-3, "dx = {}", s.dx);
                assert!(s.dy.abs() < 1e-3, "dy = {}", s.dy);
            }
        }
    }

    /// Disconnected components: matches between (0,1) and (2,3) but
    /// no path between component A {0,1} and component B {2,3}.
    /// Each component should solve independently; the gauge prior
    /// pulls each to zero total displacement.
    #[test]
    fn disconnected_components_each_solve_independently() {
        let canvas = rectilinear_canvas(400, 300);
        let mesh = LocalWarpOptions {
            mesh_cols: 3,
            mesh_rows: 3,
            max_displacement_px: 256.0,
        };
        let opts = GlobalMeshOptions {
            mesh,
            lambda_smooth: 5.0,
            lambda_zero: 0.1,
        };
        let mut observations: Vec<MatchObservation> = Vec::new();
        // Component A: matches between images 0 and 1.
        for k in 0..9 {
            let cx = 50.0 + (k % 3) as f32 * 100.0;
            let cy = 50.0 + (k / 3) as f32 * 80.0;
            observations.push(MatchObservation::new(0, 1, (cx, cy), (cx + 3.0, cy)));
        }
        // Component B: matches between images 2 and 3.
        for k in 0..9 {
            let cx = 50.0 + (k % 3) as f32 * 100.0;
            let cy = 50.0 + (k / 3) as f32 * 80.0;
            observations.push(MatchObservation::new(2, 3, (cx, cy), (cx, cy + 3.0)));
        }
        let fields = solve_global_mesh(&observations, 4, &canvas, opts).expect("solve");
        assert_eq!(fields.len(), 4);
        // Sample at component A's match centre. Image 0 should
        // push +x relative to image 1.
        let s0 = fields[0].sample(150.0, 130.0).expect("sample");
        let s1 = fields[1].sample(150.0, 130.0).expect("sample");
        assert!(
            (s0.dx - s1.dx - 3.0).abs() < 1.0,
            "component A: expected x-disagreement closure ≈3, got s0.dx={} s1.dx={}",
            s0.dx, s1.dx
        );
        // Component B closure on y axis.
        let s2 = fields[2].sample(150.0, 130.0).expect("sample");
        let s3 = fields[3].sample(150.0, 130.0).expect("sample");
        assert!(
            (s2.dy - s3.dy - 3.0).abs() < 1.0,
            "component B: expected y-disagreement closure ≈3, got s2.dy={} s3.dy={}",
            s2.dy, s3.dy
        );
    }

    /// Determinism / gauge stability: two runs of the same problem
    /// produce bit-identical results (no RNG, no iterative method
    /// here).
    #[test]
    fn deterministic_repeat_run() {
        let canvas = rectilinear_canvas(400, 300);
        let opts = GlobalMeshOptions::default();
        let observations: Vec<MatchObservation> = (0..16)
            .map(|i| {
                let row = (i % 4) as f32;
                let col = (i / 4) as f32;
                let cx = 50.0 + col * 75.0;
                let cy = 50.0 + row * 60.0;
                MatchObservation::new(0, 1, (cx, cy), (cx + 4.0, cy + 2.0))
            })
            .collect();
        let f1 = solve_global_mesh(&observations, 2, &canvas, opts).expect("a");
        let f2 = solve_global_mesh(&observations, 2, &canvas, opts).expect("b");
        for (a, b) in f1.iter().zip(f2.iter()) {
            for y in (0..300).step_by(50) {
                for x in (0..400).step_by(50) {
                    let sa = a.sample(x as f32, y as f32).expect("a");
                    let sb = b.sample(x as f32, y as f32).expect("b");
                    assert!((sa.dx - sb.dx).abs() < 1e-9, "dx mismatch");
                    assert!((sa.dy - sb.dy).abs() < 1e-9, "dy mismatch");
                }
            }
        }
    }
}

//! Ground-truth pitch-sweep scenes shared by the transverse gates
//! (`transverse_gates.rs`, `roll_leveling_gates.rs`): camera sets,
//! frames rendered by the `pano-gt-render` machinery, and the spec §7
//! composite-vs-source RMSE gate.

use std::f64::consts::FRAC_PI_2;
use std::ops::Range;

use maple_pano::camera::Camera;
use maple_pano::canvas::CanvasSpec;
use maple_pano::composite::{composite, CompositeOptions};
use maple_pano::ingest::{PlanarImage, ValidityMask};
use maple_pano::math::{matrix_to_axis_angle, Mat3, Vec3};
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::source::EquirectSource;
use maple_pano::Projection;

/// `count` frames sweeping pitch around `pitch_deg`, `width × ¾ width`.
pub fn pitch_ring(
    count: u32,
    fov_deg: f64,
    overlap: f64,
    pitch_deg: f64,
    width: u32,
    seed: u64,
) -> Vec<Camera> {
    let opts = CameraSetOptions {
        count,
        pattern: Pattern::Grid { rows: count },
        fov_deg,
        overlap,
        pitch_deg,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width,
        height: width * 3 / 4,
    };
    build_camera_set(&opts, &mut SplitMix64::new(seed))
        .expect("valid options")
        .iter()
        .map(|c| c.to_camera())
        .collect()
}

/// The same set under the global rotation `turn`.
pub fn turned(cams: Vec<Camera>, turn: Mat3) -> Vec<Camera> {
    cams.into_iter()
        .map(|c| {
            let rotation = turn.mul_mat(&c.rotation);
            Camera {
                rotation,
                axis_angle: matrix_to_axis_angle(&rotation),
                ..c
            }
        })
        .collect()
}

/// A synthetic equirect source seen from the world through `to_source`.
pub struct Scene {
    source: EquirectSource,
    to_source: Mat3,
}

impl Scene {
    pub fn new(seed: u64) -> Self {
        Self {
            source: EquirectSource::synthetic(2048, 1024, seed).expect("source"),
            to_source: Mat3::identity(),
        }
    }

    /// The source's own poles turned onto the pitch axis of a sweep
    /// heading `heading_deg`, where no frame looks. An equirect source is
    /// degenerate at its poles (a canvas pixel there spans many source
    /// columns, so the single-tap reference and the supersampled frames
    /// disagree), which would otherwise be charged to the compositor at
    /// the world zenith.
    pub fn poles_on_pitch_axis(seed: u64, heading_deg: f64) -> Self {
        Self {
            to_source: Mat3::rotation_z(FRAC_PI_2)
                .mul_mat(&Mat3::rotation_y(-heading_deg.to_radians())),
            ..Self::new(seed)
        }
    }

    pub fn sample(&self, dir: Vec3) -> Option<[f64; 3]> {
        self.source.sample_dir(self.to_source.mul_vec(dir))
    }

    pub fn frames(&self, cams: &[Camera]) -> Vec<PlanarImage> {
        turned(cams.to_vec(), self.to_source)
            .iter()
            .map(|cam| {
                let data = render_frame(&self.source, cam, 2).expect("render");
                let plane = |c: usize| -> Vec<f32> {
                    data.chunks_exact(3)
                        .map(|px| px[c] as f32 / 65535.0)
                        .collect()
                };
                PlanarImage::from_planes(
                    cam.width,
                    cam.height,
                    plane(0),
                    plane(1),
                    plane(2),
                    ValidityMask::new_filled(cam.width, cam.height, true),
                )
            })
            .collect()
    }

    /// RMSE of the composite against a direct resample of the source at
    /// canvas resolution over the valid pixels of `rows`: (rmse,
    /// compared fraction).
    fn rmse_in_rows(&self, out: &PlanarImage, canvas: &CanvasSpec, rows: Range<u32>) -> (f64, f64) {
        let w = out.width();
        let pixels = (rows.len() * w as usize * 3).max(1);
        let (sum_sq, count) = rows
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .filter(|&(x, y)| out.validity.get(x, y))
            .filter_map(|(x, y)| {
                let reference =
                    self.sample(canvas.pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5)?)?;
                let i = (y as usize) * (w as usize) + x as usize;
                Some(
                    [&out.r, &out.g, &out.b]
                        .iter()
                        .enumerate()
                        .map(|(c, plane)| (plane[i] as f64 - reference[c]).powi(2))
                        .sum::<f64>(),
                )
            })
            .fold((0.0, 0usize), |(s, n), e| (s + e, n + 3));
        (
            (sum_sq / count.max(1) as f64).sqrt(),
            count as f64 / pixels as f64,
        )
    }

    pub fn rmse(&self, out: &PlanarImage, canvas: &CanvasSpec) -> (f64, f64) {
        self.rmse_in_rows(out, canvas, 0..out.height())
    }

    /// [`Scene::rmse`] over the 33 rows centred on the zenith's row,
    /// where the standard surfaces have their pole.
    pub fn zenith_band_rmse(&self, out: &PlanarImage, canvas: &CanvasSpec) -> (f64, f64) {
        let (_, row) = canvas
            .dir_to_pixel(Vec3::new(0.0, -1.0, 0.0))
            .expect("the zenith is on the canvas");
        let row = row as u32;
        self.rmse_in_rows(
            out,
            canvas,
            row.saturating_sub(16)..(row + 17).min(out.height()),
        )
    }

    /// Composite `frames` with `cams` and hold it to spec §7: the
    /// expected projection, most of the canvas compared, RMSE < 0.5 % of
    /// full scale.
    pub fn gate(
        &self,
        cams: &[Camera],
        frames: &[PlanarImage],
        expected: Projection,
    ) -> (PlanarImage, CanvasSpec, f64) {
        let (out, report) =
            composite(frames, cams, &CompositeOptions::default(), &[]).expect("composite");
        let (rmse, covered) = self.rmse(&out, &report.canvas);
        println!(
            "{expected:?} gate: rmse {:.5} ({:.3}% of full scale), {:.1}% compared, canvas {}x{}",
            rmse,
            rmse * 100.0,
            covered * 100.0,
            report.canvas.width,
            report.canvas.height
        );
        assert_eq!(report.projection, expected);
        assert!(covered > 0.5, "the sweep must cover most of the canvas");
        assert!(rmse < 0.005, "spec §7: RMSE {rmse} ≥ 0.5% of full scale");
        (out, report.canvas, rmse)
    }

    /// The zenith rows of a composite hold to the same §7 bar.
    pub fn gate_zenith_band(&self, out: &PlanarImage, canvas: &CanvasSpec) {
        let (rmse, covered) = self.zenith_band_rmse(out, canvas);
        println!(
            "zenith band: rmse {rmse:.5}, {:.1}% compared",
            covered * 100.0
        );
        assert!(covered > 0.5, "the zenith band must be covered");
        assert!(rmse < 0.005, "zenith band RMSE {rmse} ≥ 0.5% of full scale");
    }
}

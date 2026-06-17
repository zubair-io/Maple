//! Ground-truth frame rendering: virtual camera set construction,
//! inverse-mapped supersampled rendering, and output writing
//! (`frame_NNNN.png` + `ground_truth.json`).
//!
//! # Rendering model
//!
//! Each output pixel is inverse-mapped: pixel → (undistort →) camera ray →
//! world direction → equirect (λ, φ) → bilinear tap on the source. With
//! supersampling factor `N`, the pixel value is the mean of `N × N`
//! sub-samples on a regular grid inside the pixel footprint
//! (`px = ix + (sx + 0.5)/N`). Accumulation in `f64`, quantization
//! `round(clamp(v, 0, 1) · 65535)` to 16-bit.
//!
//! # Determinism
//!
//! Same options + same seed → byte-identical frames and JSON **on a given
//! platform and toolchain**. All randomness (camera jitter, synthetic
//! scene) comes from [`SplitMix64`] streams derived from the master seed;
//! per-pixel work is pure, so rayon row-parallelism cannot affect values.
//! Across *different* targets or dependency bumps, transcendentals
//! (`sin_cos`, `atan2`, …) come from the platform libm and PNG bytes from
//! the `png` encoder, so cross-platform identity is not promised — the
//! parity harness compares cross-platform outputs with a tolerance, not
//! byte equality.
//!
//! # Camera parameter quantization
//!
//! Camera parameters are computed in `f64`, **quantized to `f32`, and the
//! quantized values are used for rendering** — so `ground_truth.json`
//! (which stores `f32`) describes the render mapping exactly.

use std::borrow::Cow;
use std::io::Write as _;
use std::path::Path;

use rayon::prelude::*;

use crate::camera::{focal_px_for_hfov, Camera};
use crate::error::PanoError;
use crate::gt::{CameraGt, Convention, GroundTruth, RenderSpec, SourceSpec, GROUND_TRUTH_VERSION};
use crate::math::{axis_angle_to_matrix, matrix_to_axis_angle, Mat3};
use crate::prng::SplitMix64;
use crate::source::EquirectSource;

/// Camera placement pattern.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Pattern {
    /// Single row of yaws at the base pitch. `full = true` spaces the
    /// cameras `360°/count` apart for a closed loop (ignoring `overlap`);
    /// otherwise adjacent yaws are `fov · (1 − overlap)` apart, starting
    /// at yaw 0 and increasing eastward.
    Ring { full: bool },
    /// `rows` rows × `ceil(count/rows)` columns of yaw/pitch, centered on
    /// (yaw 0, base pitch); spacing is `fov · (1 − overlap)` per axis
    /// (vertical uses the vertical FOV implied by the aspect ratio).
    /// Row 0 is the top row (highest pitch); cameras fill row-major.
    Grid { rows: u32 },
}

/// Options describing the virtual camera set.
#[derive(Debug, Clone)]
pub struct CameraSetOptions {
    pub count: u32,
    pub pattern: Pattern,
    /// Per-camera horizontal field of view, degrees.
    pub fov_deg: f64,
    /// Fraction of the FOV shared between pattern neighbors, `[0, 0.95]`.
    pub overlap: f64,
    /// Base pitch, degrees (positive = up).
    pub pitch_deg: f64,
    /// Max magnitude of the random per-camera rotation jitter, degrees.
    pub jitter_deg: f64,
    pub k1: f64,
    pub k2: f64,
    /// Frame size in pixels.
    pub width: u32,
    pub height: u32,
}

/// Build the camera set: pattern pose ∘ jitter, then quantize every
/// parameter to `f32` (see module docs). `rng` drives the jitter — three
/// draws per camera, consumed even when `jitter_deg = 0` so the stream
/// layout is flag-independent.
///
/// Errors with [`PanoError::InvalidOptions`] on a zero camera count or a
/// `Grid { rows: 0 }` pattern (which would otherwise divide by zero).
pub fn build_camera_set(
    opts: &CameraSetOptions,
    rng: &mut SplitMix64,
) -> Result<Vec<CameraGt>, PanoError> {
    if opts.count == 0 {
        return Err(PanoError::InvalidOptions(
            "camera count must be >= 1".into(),
        ));
    }
    if let Pattern::Grid { rows: 0 } = opts.pattern {
        return Err(PanoError::InvalidOptions(
            "grid pattern requires rows >= 1".into(),
        ));
    }
    let hfov = opts.fov_deg.to_radians();
    let vfov = 2.0 * ((hfov * 0.5).tan() * opts.height as f64 / opts.width as f64).atan();
    let focal = focal_px_for_hfov(opts.fov_deg, opts.width) as f32;
    let (rows, cols) = match opts.pattern {
        Pattern::Ring { .. } => (1, opts.count),
        Pattern::Grid { rows } => (rows, opts.count.div_ceil(rows)),
    };
    let h_step = match opts.pattern {
        Pattern::Ring { full: true } => std::f64::consts::TAU / opts.count as f64,
        _ => hfov * (1.0 - opts.overlap),
    };
    let v_step = vfov * (1.0 - opts.overlap);

    Ok((0..opts.count)
        .map(|i| {
            // Jitter draws happen for every camera regardless of pattern
            // math, keeping the PRNG stream layout stable.
            let jitter_axis = rng.next_unit_vector();
            let jitter_angle = rng.next_f64() * opts.jitter_deg.to_radians();

            let (row, col) = (i / cols, i % cols);
            let (yaw, pitch) = match opts.pattern {
                Pattern::Ring { .. } => (i as f64 * h_step, opts.pitch_deg.to_radians()),
                Pattern::Grid { .. } => (
                    (col as f64 - (cols - 1) as f64 * 0.5) * h_step,
                    opts.pitch_deg.to_radians() + ((rows - 1) as f64 * 0.5 - row as f64) * v_step,
                ),
            };
            // Pose: R = Ry(yaw) · Rx(pitch) · exp([jitter]×) — jitter
            // perturbs in the camera frame.
            let base = Mat3::rotation_y(yaw).mul_mat(&Mat3::rotation_x(pitch));
            let jitter = axis_angle_to_matrix([
                jitter_axis.x * jitter_angle,
                jitter_axis.y * jitter_angle,
                jitter_axis.z * jitter_angle,
            ]);
            let omega = matrix_to_axis_angle(&base.mul_mat(&jitter));
            CameraGt {
                frame: format!("frame_{i:04}.png"),
                axis_angle: [omega[0] as f32, omega[1] as f32, omega[2] as f32],
                focal_px: focal,
                k1: opts.k1 as f32,
                k2: opts.k2 as f32,
                width: opts.width,
                height: opts.height,
            }
        })
        .collect())
}

/// Render one camera's frame: row-major interleaved RGB, 16-bit.
///
/// Errors only when the distortion polynomial is not invertible somewhere
/// inside the (supersampled) pixel grid — i.e. physically implausible
/// k1/k2 for the chosen FOV.
pub fn render_frame(
    source: &EquirectSource,
    cam: &Camera,
    supersample: u32,
) -> Result<Vec<u16>, PanoError> {
    let w = cam.width as usize;
    let h = cam.height as usize;
    let n = supersample.max(1) as usize;
    let inv_n = 1.0 / n as f64;
    let inv_count = 1.0 / (n * n) as f64;

    let rows: Result<Vec<Vec<u16>>, PanoError> = (0..h)
        .into_par_iter()
        .map(|iy| {
            let mut row = vec![0_u16; w * 3];
            for ix in 0..w {
                let mut acc = [0.0_f64; 3];
                for sy in 0..n {
                    let py = iy as f64 + (sy as f64 + 0.5) * inv_n;
                    for sx in 0..n {
                        let px = ix as f64 + (sx as f64 + 0.5) * inv_n;
                        let dir = cam.pixel_to_world_dir(px, py).ok_or(
                            PanoError::DistortionNotInvertible {
                                k1: cam.k1,
                                k2: cam.k2,
                                px,
                                py,
                            },
                        )?;
                        // sample_dir is total for unit directions.
                        let s = source.sample_dir(dir).expect("unit dir");
                        acc[0] += s[0];
                        acc[1] += s[1];
                        acc[2] += s[2];
                    }
                }
                for c in 0..3 {
                    let v = (acc[c] * inv_count).clamp(0.0, 1.0);
                    row[ix * 3 + c] = (v * 65535.0).round() as u16;
                }
            }
            Ok(row)
        })
        .collect();
    Ok(rows?.concat())
}

/// Optional metadata to embed in a display PNG via `write_frame_png`.
///
/// `exif_blob` is a raw TIFF/EXIF byte stream for the `eXIf` chunk.
/// When `tag_srgb` is true the PNG encoder adds an `sRGB` chunk
/// (rendering intent: Perceptual) plus companion `gAMA` / `cHRM` chunks.
/// Neither field is mandatory; pass `Default::default()` for the
/// scene-linear carrier (no tags).
#[derive(Debug, Default)]
pub struct PngMetadata {
    /// TIFF-format EXIF blob for the `eXIf` chunk, or `None`.
    pub exif_blob: Option<Vec<u8>>,
    /// Add an `sRGB` chunk (and `gAMA`/`cHRM` companion chunks).
    pub tag_srgb: bool,
}

/// Write an interleaved 16-bit RGB buffer as a PNG.
///
/// Pass `meta.tag_srgb = true` and/or `meta.exif_blob = Some(blob)` for the
/// sRGB-display-encoded pano output. Leave both `None`/`false` for the
/// scene-linear carrier (`.linear.png`).
pub fn write_frame_png(
    path: &Path,
    width: u32,
    height: u32,
    data: &[u16],
    meta: &PngMetadata,
) -> Result<(), PanoError> {
    debug_assert_eq!(data.len(), width as usize * height as usize * 3);
    let file = std::fs::File::create(path).map_err(|e| PanoError::io(path, e))?;

    let mut info = png::Info::with_size(width, height);
    info.color_type = png::ColorType::Rgb;
    info.bit_depth = png::BitDepth::Sixteen;

    if meta.tag_srgb {
        // `srgb` is a public field on `Info`; the `png` encoder writes an
        // `sRGB` chunk for it (PNG spec §11.3.2.5).  The companion `gAMA` and
        // `cHRM` chunks are written automatically by the encoder when
        // `source_gamma` / `source_chromaticities` are also set, but the
        // `sRGB` chunk alone is sufficient for Apple ImageIO / CGImageSource
        // to identify the color space as sRGB.
        info.srgb = Some(png::SrgbRenderingIntent::Perceptual);
    }

    if let Some(blob) = &meta.exif_blob {
        info.exif_metadata = Some(Cow::Borrowed(blob.as_slice()));
    }

    let enc = png::Encoder::with_info(std::io::BufWriter::new(file), info)?;
    let mut writer = enc.write_header()?;

    // PNG 16-bit samples are big-endian.
    let mut bytes = Vec::with_capacity(data.len() * 2);
    for &v in data {
        bytes.extend_from_slice(&v.to_be_bytes());
    }
    writer.write_image_data(&bytes)?;
    Ok(())
}

/// What to render from.
#[derive(Debug, Clone)]
pub enum SourceKind {
    /// Procedural scene of the given size (width = 2 × height).
    Synthetic { width: u32, height: u32 },
    /// Equirect PNG on disk (treated as linear).
    File { path: std::path::PathBuf },
}

/// A full render job: source + camera set + render parameters.
#[derive(Debug, Clone)]
pub struct RenderJob {
    pub source: SourceKind,
    pub set: CameraSetOptions,
    /// Per-axis supersampling factor (`N` → `N × N` taps per pixel).
    pub supersample: u32,
    /// Master seed: the synthetic scene uses it directly; camera jitter
    /// uses an independent stream derived from it.
    pub seed: u64,
}

/// Run a job: render every frame into `out_dir` and write
/// `ground_truth.json`. Returns the document that was written.
///
/// `progress` is called once per completed frame with (index, file name).
pub fn run(
    job: &RenderJob,
    out_dir: &Path,
    mut progress: impl FnMut(usize, &str),
) -> Result<GroundTruth, PanoError> {
    let source = match &job.source {
        SourceKind::Synthetic { width, height } => {
            EquirectSource::synthetic(*width, *height, job.seed)?
        }
        SourceKind::File { path } => EquirectSource::from_png(path)?,
    };
    // Independent jitter stream: cameras stay identical whether the scene
    // is synthetic or file-based.
    let mut cam_rng = SplitMix64::new(job.seed ^ 0xA076_1D64_78BD_642F);
    let cameras = build_camera_set(&job.set, &mut cam_rng)?;

    std::fs::create_dir_all(out_dir).map_err(|e| PanoError::io(out_dir, e))?;
    for (i, gt_cam) in cameras.iter().enumerate() {
        let cam = gt_cam.to_camera();
        let frame = render_frame(&source, &cam, job.supersample)?;
        write_frame_png(
            &out_dir.join(&gt_cam.frame),
            cam.width,
            cam.height,
            &frame,
            &PngMetadata::default(),
        )?;
        progress(i, &gt_cam.frame);
    }

    let gt = GroundTruth {
        version: GROUND_TRUTH_VERSION,
        convention: Convention::current(),
        source: SourceSpec {
            projection: "equirectangular".into(),
            kind: match &job.source {
                SourceKind::Synthetic { .. } => "synthetic".into(),
                SourceKind::File { .. } => "file".into(),
            },
            width: source.width,
            height: source.height,
            lon_range_deg: [-180.0, 180.0],
            lat_range_deg: [-90.0, 90.0],
            seed: match &job.source {
                SourceKind::Synthetic { .. } => Some(job.seed),
                SourceKind::File { .. } => None,
            },
            path: match &job.source {
                SourceKind::Synthetic { .. } => None,
                SourceKind::File { path } => Some(path.display().to_string()),
            },
        },
        render: RenderSpec {
            supersample: job.supersample,
            seed: job.seed,
        },
        cameras,
    };
    let json_path = out_dir.join("ground_truth.json");
    let mut json = serde_json::to_string_pretty(&gt).expect("schema serializes");
    json.push('\n');
    let mut file = std::fs::File::create(&json_path).map_err(|e| PanoError::io(&json_path, e))?;
    file.write_all(json.as_bytes())
        .map_err(|e| PanoError::io(&json_path, e))?;
    Ok(gt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_source(value: f32) -> EquirectSource {
        EquirectSource {
            width: 32,
            height: 16,
            pixels: vec![[value; 3]; 32 * 16],
        }
    }

    /// End-to-end sampling sanity: a constant source renders to the exact
    /// quantized constant at every pixel, any supersampling, any pose.
    #[test]
    fn constant_source_renders_constant_frame() {
        let src = flat_source(0.25);
        let cam = Camera::new([0.1, 0.8, -0.05], 80.0, -0.05, 0.01, 24, 18);
        for ss in [1, 2, 3] {
            let frame = render_frame(&src, &cam, ss).unwrap();
            let expected = (0.25_f64 * 65535.0).round() as u16;
            assert!(frame.iter().all(|&v| v == expected), "ss = {ss}");
        }
    }

    /// Identity camera, odd frame width, ss = 1: the center pixel's single
    /// sub-sample is exactly the optical axis → samples the source at
    /// (λ = 0, φ = 0). Make that spot bright and check it lands there.
    #[test]
    fn identity_camera_center_pixel_samples_lon0_lat0() {
        let mut src = flat_source(0.0);
        // λ = 0, φ = 0 → (u, v) = (16, 8): straddles texels 15|16 and
        // rows 7|8 — set the 2×2 block so the bilinear tap is exact.
        for (ix, iy) in [(15, 7), (16, 7), (15, 8), (16, 8)] {
            src.pixels[iy * 32 + ix] = [0.5; 3];
        }
        let cam = Camera::new([0.0; 3], 12.0, 0.0, 0.0, 9, 7);
        let frame = render_frame(&src, &cam, 1).unwrap();
        let center = frame[(3 * 9 + 4) * 3];
        assert_eq!(center, (0.5_f64 * 65535.0).round() as u16);
    }

    #[test]
    fn build_camera_set_rejects_invalid_options() {
        let base = CameraSetOptions {
            count: 4,
            pattern: Pattern::Ring { full: false },
            fov_deg: 60.0,
            overlap: 0.3,
            pitch_deg: 0.0,
            jitter_deg: 0.0,
            k1: 0.0,
            k2: 0.0,
            width: 64,
            height: 48,
        };
        let zero_rows = CameraSetOptions {
            pattern: Pattern::Grid { rows: 0 },
            ..base.clone()
        };
        assert!(matches!(
            build_camera_set(&zero_rows, &mut SplitMix64::new(0)),
            Err(PanoError::InvalidOptions(_))
        ));
        let zero_count = CameraSetOptions { count: 0, ..base };
        assert!(matches!(
            build_camera_set(&zero_count, &mut SplitMix64::new(0)),
            Err(PanoError::InvalidOptions(_))
        ));
    }

    #[test]
    fn ring_full_spaces_cameras_evenly() {
        let opts = CameraSetOptions {
            count: 4,
            pattern: Pattern::Ring { full: true },
            fov_deg: 60.0,
            overlap: 0.3,
            pitch_deg: 0.0,
            jitter_deg: 0.0,
            k1: 0.0,
            k2: 0.0,
            width: 64,
            height: 48,
        };
        let cams = build_camera_set(&opts, &mut SplitMix64::new(0)).expect("valid options");
        assert_eq!(cams.len(), 4);
        // Camera i looks at lon = i·90°; check via the optical axis.
        for (i, gt_cam) in cams.iter().enumerate() {
            let cam = gt_cam.to_camera();
            let d = cam.rotation.mul_vec(crate::math::Vec3::new(0.0, 0.0, 1.0));
            let lon = d.x.atan2(d.z).to_degrees().rem_euclid(360.0);
            let want = (i as f64 * 90.0).rem_euclid(360.0);
            let err = (lon - want).abs().min(360.0 - (lon - want).abs());
            assert!(err < 1e-4, "camera {i}: lon {lon}, want {want}");
        }
    }

    #[test]
    fn grid_pattern_is_centered() {
        let opts = CameraSetOptions {
            count: 4,
            pattern: Pattern::Grid { rows: 2 },
            fov_deg: 60.0,
            overlap: 0.5,
            pitch_deg: 0.0,
            jitter_deg: 0.0,
            k1: 0.0,
            k2: 0.0,
            width: 64,
            height: 48,
        };
        let cams = build_camera_set(&opts, &mut SplitMix64::new(0)).expect("valid options");
        // 2×2 grid centered on (0, 0): yaw/pitch means must be ~0, top row
        // pitched up relative to the bottom row.
        let axes: Vec<_> = cams
            .iter()
            .map(|c| {
                c.to_camera()
                    .rotation
                    .mul_vec(crate::math::Vec3::new(0.0, 0.0, 1.0))
            })
            .collect();
        let mean_x: f64 = axes.iter().map(|d| d.x).sum::<f64>() / 4.0;
        let mean_y: f64 = axes.iter().map(|d| d.y).sum::<f64>() / 4.0;
        assert!(mean_x.abs() < 1e-9 && mean_y.abs() < 1e-9);
        assert!(axes[0].y < axes[2].y, "row 0 must pitch up (−y) vs row 1");
    }

    #[test]
    fn jitter_zero_means_exact_pattern_pose() {
        let opts = CameraSetOptions {
            count: 2,
            pattern: Pattern::Ring { full: false },
            fov_deg: 50.0,
            overlap: 0.4,
            pitch_deg: 10.0,
            jitter_deg: 0.0,
            k1: 0.0,
            k2: 0.0,
            width: 64,
            height: 48,
        };
        let cams = build_camera_set(&opts, &mut SplitMix64::new(99)).expect("valid options");
        let cam1 = cams[1].to_camera();
        let h_step = 50.0_f64.to_radians() * 0.6;
        let want = Mat3::rotation_y(h_step).mul_mat(&Mat3::rotation_x(10.0_f64.to_radians()));
        // f32 quantization of the axis-angle bounds the matrix error.
        assert!(cam1.rotation.max_abs_diff(&want) < 1e-6);
    }

    /// write_frame_png with PngMetadata embedding: verify that the written PNG
    /// file contains an `eXIf` chunk and an `sRGB` chunk.
    ///
    /// This test reads back the raw PNG bytes and scans for the chunk type
    /// bytes rather than going through the decoder, so it works on any host
    /// without extra dependencies.
    #[test]
    fn write_frame_png_embeds_exif_and_srgb_chunks() {
        use crate::exif_embed::build_exif_blob;
        use raw_core::Exif;

        let exif = Exif {
            camera_make: Some("TestMake".into()),
            camera_model: Some("TestModel".into()),
            iso: Some(400),
            aperture: Some(4.0),
            shutter_s: Some(1.0 / 100.0),
            focal_mm: Some(50.0),
            ..Default::default()
        };
        let exif_blob = build_exif_blob(&exif).expect("blob must be Some for rich Exif");

        // Write a tiny 2×2 16-bit RGB PNG with EXIF + sRGB metadata.
        let tmp = std::env::temp_dir().join("maple_pano_metadata_test.png");
        let data: Vec<u16> = vec![0x1234u16; 2 * 2 * 3];
        let meta = PngMetadata {
            exif_blob: Some(exif_blob),
            tag_srgb: true,
        };
        write_frame_png(&tmp, 2, 2, &data, &meta).expect("write must succeed");

        // Read back the raw PNG bytes and scan for chunk types.
        let bytes = std::fs::read(&tmp).expect("PNG file must exist after write");

        // PNG signature is 8 bytes; then chunks follow: 4-byte length, 4-byte
        // type, data, 4-byte CRC. Scan for known chunk type bytes.
        let has_chunk = |name: &[u8; 4]| -> bool { bytes.windows(4).any(|w| w == name) };

        assert!(has_chunk(b"sRGB"), "sRGB chunk must be present");
        assert!(has_chunk(b"eXIf"), "eXIf chunk must be present");

        // Clean up (ignore failure — tests that share /tmp may race).
        let _ = std::fs::remove_file(&tmp);
    }

    /// write_frame_png with default (no) metadata: verify no eXIf chunk is
    /// written (the scene-linear carrier must stay clean).
    #[test]
    fn write_frame_png_no_metadata_omits_exif_chunk() {
        let tmp = std::env::temp_dir().join("maple_pano_no_metadata_test.png");
        let data: Vec<u16> = vec![0xAAAAu16; 2 * 2 * 3];
        write_frame_png(&tmp, 2, 2, &data, &PngMetadata::default()).expect("write must succeed");

        let bytes = std::fs::read(&tmp).expect("PNG file must exist");
        let has_exif = bytes.windows(4).any(|w| w == b"eXIf");
        assert!(!has_exif, "no eXIf chunk in scene-linear carrier");

        let _ = std::fs::remove_file(&tmp);
    }
}

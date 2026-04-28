//! `pano-smoke` — smoke-test CLI for the panorama stitching pipeline.
//!
//! # Usage
//!
//! ```text
//! STITCH MODE:
//!   pano-smoke <input1> <input2> [<input3> ...] -o <output.png>
//!
//! FIXTURE GENERATION MODE:
//!   pano-smoke --gen-fixtures <dir>
//!
//! OPTIONS:
//!   -o, --output PATH      Output PNG16 path (required for stitch mode).
//!   --max-dim N            Clamp output long edge to N pixels (default: unconstrained).
//!   --gen-fixtures DIR     Generate deterministic synthetic fixtures into DIR.
//!                          Writes:
//!                            <DIR>/corpus/synthetic_a.png
//!                            <DIR>/corpus/synthetic_b.png
//!                            <DIR>/references/synthetic.png
//! ```
//!
//! # Pipeline (stitch mode, 2-image MVP)
//!
//! 1. Decode each PNG input. Convert sRGB u8/u16 → linear f32 → Rec.2020
//!    working space via the M_REC2020_TO_SRGB⁻¹ matrix from raw-core.
//! 2. Run `OrbDetector::detect` on both → `Features`.
//! 3. Run `BruteForceMatcher::match_pairs` → `Matches`.
//! 4. Run `ba::homography::ransac_homography` for the pairwise homography.
//! 5. Run `ba::lm::solve_with_keypoints` for per-image cameras.
//! 6. Warp both images with `CpuWarper` onto a shared canvas.
//! 7. Find the seam with `GraphCutSeamFinder`.
//! 8. Blend with `MultiBandBlender`.
//! 9. Convert Rec.2020 linear f32 → sRGB u16, write PNG16.
//!
//! # --gen-fixtures mode
//!
//! Produces a 256 × 256 synthetic reference image (deterministic RNG, seed=42)
//! and two overlapping crops of it that simulate a 2-image panorama with a
//! known horizontal translation.  The reference is the complete synthetic
//! source; images A and B are its left and right halves (with 64-pixel overlap)
//! embedded into a zero-padded 256 × 256 frame so the pipeline sees same-size
//! inputs.

use std::fs;
use std::path::{Path, PathBuf};

use clap::Parser;
use pano_core::{
    ba::{
        focal::focal_from_homography,
        homography::{ransac_homography, rotation_from_homography},
        joint::{rodrigues_log, solve_joint_with_priors, CameraPrior, JointRotationFocalBA},
        lm::solve_with_keypoints,
    },
    features::akaze::AkazeDetector,
    matching::{gimbal_filter, gms_filter, predicted_homography, BruteForceMatcher},
    types::{Camera, Features, Matches, PanoImage},
    Blender, ColorSpace, CpuWarper, FeatureDetector, FeatureMatcher,
    GraphCutMaxFlowSeamFinder,
    Projection, SeamFinder,
};
use raw_core::color::matrices::M_REC2020_TO_SRGB;

// ---------------------------------------------------------------------------
// Generic format loader (T2.1) — replaces the PNG-only path in stitch mode.
// ---------------------------------------------------------------------------

/// Load any supported image from disk by sniffing its bytes, then decode into
/// a `PanoImage` in the Rec.2020 D65 linear working space.
///
/// Delegates to `pano_core::ingest::decode_bytes` which handles PNG, JPEG,
/// and TIFF/RAW (DNG/NEF/CR2/ARW) via magic-byte detection.
fn load_image_any_format(path: &Path) -> Result<PanoImage, String> {
    let bytes = fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    pano_core::decode_bytes(&bytes)
        .map_err(|e| format!("decode failed for {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

#[derive(Parser, Debug)]
#[command(
    name = "pano-smoke",
    about = "Panorama stitching smoke test and golden harness driver"
)]
struct Cli {
    /// Input PNG images to stitch (2–8).  Ignored when --gen-fixtures is set.
    inputs: Vec<PathBuf>,

    /// Output PNG16 path (required for stitch mode).
    #[arg(short, long, value_name = "PATH")]
    output: Option<PathBuf>,

    /// Clamp the output long edge to this many pixels (0 = unconstrained).
    #[arg(long, default_value_t = 0)]
    max_dim: u32,

    /// Projection to use for the output canvas: cylindrical, spherical, or rectilinear.
    /// Default is cylindrical (horizontal panoramas). Use spherical for multi-row
    /// panoramas with significant pitch coverage (e.g. pano_01).
    #[arg(long, default_value = "cylindrical", value_name = "PROJECTION")]
    projection: String,

    /// Generate deterministic synthetic fixtures into DIR and exit.
    #[arg(long, value_name = "DIR")]
    gen_fixtures: Option<PathBuf>,
}

// ---------------------------------------------------------------------------
// Color conversion helpers
// ---------------------------------------------------------------------------

/// sRGB transfer function — encode linear f32 to sRGB.
///
/// IEC 61966-2-1 piece-wise formula.
#[inline]
fn srgb_encode(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

/// sRGB transfer function — decode sRGB [0,1] to linear f32.
#[inline]
fn srgb_decode(x: f32) -> f32 {
    if x <= 0.04045 {
        x / 12.92
    } else {
        ((x + 0.055) / 1.055).powf(2.4)
    }
}

/// Inline Rec.2020 → sRGB linear matrix (row-major, same values as
/// `raw_core::color::matrices::M_REC2020_TO_SRGB` but operating on f32
/// triplets directly).
///
/// We use raw-core's constant to stay numerically consistent.
#[inline]
fn rec2020_linear_to_srgb_linear(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let v = M_REC2020_TO_SRGB.mul_vec([r, g, b]);
    (v[0], v[1], v[2])
}

/// Inverse of `M_REC2020_TO_SRGB` — sRGB linear → Rec.2020 linear.
///
/// Computed on first call; cached inline by the caller.
fn srgb_linear_to_rec2020_linear(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    // M_REC2020_TO_SRGB⁻¹ (inverse precomputed analytically).
    // The exact values come from inverting the constant:
    //
    //  [ 1.6605 -0.5876 -0.0728 ]
    //  [-0.1246  1.1329 -0.0083 ]
    //  [-0.0182 -0.1006  1.1187 ]
    //
    // We call the crate's `inverse()` at runtime and cache it once.
    use std::sync::OnceLock;
    static INV: OnceLock<[[f32; 3]; 3]> = OnceLock::new();
    let inv = INV.get_or_init(|| {
        M_REC2020_TO_SRGB
            .inverse()
            .expect("M_REC2020_TO_SRGB is always invertible")
            .0
    });
    let m = inv;
    let or = m[0][0] * r + m[0][1] * g + m[0][2] * b;
    let og = m[1][0] * r + m[1][1] * g + m[1][2] * b;
    let ob = m[2][0] * r + m[2][1] * g + m[2][2] * b;
    (or, og, ob)
}

// ---------------------------------------------------------------------------
// PNG I/O
// ---------------------------------------------------------------------------

/// Load a PNG file as a `PanoImage` in the Rec.2020 D65 linear working space.
///
/// Handles 8-bit and 16-bit PNG inputs with RGB or RGBA color types.
/// Alpha channels are dropped.  sRGB gamma is removed before conversion.
///
/// Used only by the `png16_write_read_roundtrip` unit test below; production
/// loading now goes through `load_image_any_format` → `pano_core::decode_bytes`.
#[cfg(test)]
fn load_png_as_pano_image(path: &Path) -> Result<PanoImage, String> {
    let file = fs::File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let decoder = png::Decoder::new(file);
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("PNG decode error for {}: {e}", path.display()))?;

    let info = reader.info().clone();
    let width = info.width;
    let height = info.height;
    let color = info.color_type;
    let depth = info.bit_depth;

    let mut buf = vec![0u8; reader.output_buffer_size()];
    reader
        .next_frame(&mut buf)
        .map_err(|e| format!("PNG frame read error for {}: {e}", path.display()))?;

    // Number of channels: 3 for RGB, 4 for RGBA, etc.
    let channels: usize = match color {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::GrayscaleAlpha | png::ColorType::Grayscale => {
            return Err(format!(
                "unsupported PNG color type {:?} in {}",
                color,
                path.display()
            ))
        }
        png::ColorType::Indexed => {
            return Err(format!("indexed PNG not supported: {}", path.display()))
        }
    };

    let n_pixels = (width as usize) * (height as usize);
    let mut pano = PanoImage::new(width, height, ColorSpace::rec2020_d65_linear());

    match depth {
        png::BitDepth::Eight => {
            for i in 0..n_pixels {
                let base_src = i * channels;
                let r_srgb = buf[base_src] as f32 / 255.0;
                let g_srgb = buf[base_src + 1] as f32 / 255.0;
                let b_srgb = buf[base_src + 2] as f32 / 255.0;
                // sRGB → linear sRGB
                let r_lin = srgb_decode(r_srgb);
                let g_lin = srgb_decode(g_srgb);
                let b_lin = srgb_decode(b_srgb);
                // sRGB linear → Rec.2020 linear
                let (r20, g20, b20) = srgb_linear_to_rec2020_linear(r_lin, g_lin, b_lin);
                let base_dst = i * 3;
                pano.pixels[base_dst] = r20;
                pano.pixels[base_dst + 1] = g20;
                pano.pixels[base_dst + 2] = b20;
            }
        }
        png::BitDepth::Sixteen => {
            // PNG 16-bit is big-endian: each channel is two bytes.
            for i in 0..n_pixels {
                let base_src = i * channels * 2;
                let r16 = u16::from_be_bytes([buf[base_src], buf[base_src + 1]]) as f32 / 65535.0;
                let g16 =
                    u16::from_be_bytes([buf[base_src + 2], buf[base_src + 3]]) as f32 / 65535.0;
                let b16 =
                    u16::from_be_bytes([buf[base_src + 4], buf[base_src + 5]]) as f32 / 65535.0;
                // sRGB → linear sRGB
                let r_lin = srgb_decode(r16);
                let g_lin = srgb_decode(g16);
                let b_lin = srgb_decode(b16);
                // sRGB linear → Rec.2020 linear
                let (r20, g20, b20) = srgb_linear_to_rec2020_linear(r_lin, g_lin, b_lin);
                let base_dst = i * 3;
                pano.pixels[base_dst] = r20;
                pano.pixels[base_dst + 1] = g20;
                pano.pixels[base_dst + 2] = b20;
            }
        }
        other => {
            return Err(format!(
                "unsupported PNG bit depth {other:?} in {}",
                path.display()
            ))
        }
    }

    Ok(pano)
}

/// Write a `PanoImage` (Rec.2020 linear) to a 16-bit sRGB PNG file.
///
/// Applies Rec.2020 → sRGB linear matrix then the sRGB transfer encoding,
/// quantises to u16, and writes a big-endian PNG16.
fn write_pano_image_as_png16(img: &PanoImage, path: &Path) -> Result<(), String> {
    let n_pixels = (img.width as usize) * (img.height as usize);
    let mut buf = vec![0u8; n_pixels * 3 * 2]; // 16-bit big-endian, 3 channels

    for i in 0..n_pixels {
        let base_src = i * 3;
        let r20 = img.pixels[base_src];
        let g20 = img.pixels[base_src + 1];
        let b20 = img.pixels[base_src + 2];

        // Rec.2020 linear → sRGB linear
        let (r_lin, g_lin, b_lin) = rec2020_linear_to_srgb_linear(r20, g20, b20);
        // sRGB transfer encoding
        let r_enc = srgb_encode(r_lin);
        let g_enc = srgb_encode(g_lin);
        let b_enc = srgb_encode(b_lin);
        // Quantise to u16
        let r16 = (r_enc * 65535.0 + 0.5) as u16;
        let g16 = (g_enc * 65535.0 + 0.5) as u16;
        let b16 = (b_enc * 65535.0 + 0.5) as u16;

        let base_dst = i * 6;
        let [rh, rl] = r16.to_be_bytes();
        let [gh, gl] = g16.to_be_bytes();
        let [bh, bl] = b16.to_be_bytes();
        buf[base_dst] = rh;
        buf[base_dst + 1] = rl;
        buf[base_dst + 2] = gh;
        buf[base_dst + 3] = gl;
        buf[base_dst + 4] = bh;
        buf[base_dst + 5] = bl;
    }

    let file =
        fs::File::create(path).map_err(|e| format!("cannot create {}: {e}", path.display()))?;
    let mut encoder = png::Encoder::new(file, img.width, img.height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Sixteen);
    encoder.set_compression(png::Compression::Default);
    encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("PNG header error: {e}"))?;
    writer
        .write_image_data(&buf)
        .map_err(|e| format!("PNG data write error: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Fixture generation
// ---------------------------------------------------------------------------

/// Simple 64-bit LCG for deterministic pseudo-random values without external deps.
fn lcg(state: &mut u64) -> f32 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    ((*state >> 33) as f32) / (u32::MAX as f32)
}

/// Generate the 256×256 synthetic reference image.
///
/// The image contains:
/// - Low-variance Gaussian-like noise (averaged 4 LCG samples, base ≈ 0.3).
/// - 40 bright "star" dots of radius 3 at pseudo-random locations.
/// - A horizontal and vertical linear gradient overlay for large-scale structure.
///
/// All values are in sRGB [0, 1] space (to be converted to Rec.2020 before saving).
fn make_synthetic_reference(width: u32, height: u32, seed: u64) -> PanoImage {
    let mut rng = seed;
    let n = (width as usize) * (height as usize);
    // Work in sRGB space so the saved PNG looks neutral.
    let mut srgb_pixels = vec![0.0f32; n * 3];

    // Base noise layer.
    for pix in srgb_pixels.chunks_exact_mut(3) {
        let noise = (lcg(&mut rng) + lcg(&mut rng) + lcg(&mut rng) + lcg(&mut rng)) / 4.0;
        let v = 0.2 + noise * 0.2;
        pix[0] = v;
        pix[1] = v;
        pix[2] = v;
    }

    // Gradient overlay (horizontal in R, vertical in G).
    for y in 0..height {
        for x in 0..width {
            let idx = (y as usize) * (width as usize) + (x as usize);
            srgb_pixels[idx * 3] = (srgb_pixels[idx * 3] + x as f32 / width as f32 * 0.3).min(1.0);
            srgb_pixels[idx * 3 + 1] =
                (srgb_pixels[idx * 3 + 1] + y as f32 / height as f32 * 0.3).min(1.0);
        }
    }

    // Bright stars.
    let n_stars = 60usize;
    let margin = 20u32;
    for _ in 0..n_stars {
        let cx = margin + (lcg(&mut rng) * (width - 2 * margin) as f32) as u32;
        let cy = margin + (lcg(&mut rng) * (height - 2 * margin) as f32) as u32;
        let r = 3u32;
        for dy in 0..=r * 2 {
            for dx in 0..=r * 2 {
                let px = cx + dx;
                let py = cy + dy;
                if px < width && py < height {
                    let idx = (py as usize) * (width as usize) + (px as usize);
                    srgb_pixels[idx * 3] = 0.9;
                    srgb_pixels[idx * 3 + 1] = 0.9;
                    srgb_pixels[idx * 3 + 2] = 0.9;
                }
            }
        }
    }

    // Convert sRGB → linear sRGB → Rec.2020 linear.
    let mut pano = PanoImage::new(width, height, ColorSpace::rec2020_d65_linear());
    for i in 0..n {
        let r_srgb = srgb_pixels[i * 3];
        let g_srgb = srgb_pixels[i * 3 + 1];
        let b_srgb = srgb_pixels[i * 3 + 2];
        let r_lin = srgb_decode(r_srgb);
        let g_lin = srgb_decode(g_srgb);
        let b_lin = srgb_decode(b_srgb);
        let (r20, g20, b20) = srgb_linear_to_rec2020_linear(r_lin, g_lin, b_lin);
        pano.pixels[i * 3] = r20;
        pano.pixels[i * 3 + 1] = g20;
        pano.pixels[i * 3 + 2] = b20;
    }
    pano
}

/// Build image A from the reference: copy the left 192 columns (of 256),
/// zero-pad the right 64 columns, mark zero-padded region invalid.
///
/// Layout: A occupies x ∈ [0, 192), reference offset 0.
fn make_image_a(reference: &PanoImage) -> PanoImage {
    let w = reference.width;
    let h = reference.height;
    // A has the same dimensions as the reference.
    let mut a = PanoImage::new(w, h, reference.color);
    // Mark the right portion (x ≥ 192) as invalid.
    let split = 192u32;
    for y in 0..h {
        for x in 0..w {
            if x < split {
                let src_idx = (y as usize) * (w as usize) + (x as usize);
                let dst_idx = src_idx;
                a.pixels[dst_idx * 3] = reference.pixels[src_idx * 3];
                a.pixels[dst_idx * 3 + 1] = reference.pixels[src_idx * 3 + 1];
                a.pixels[dst_idx * 3 + 2] = reference.pixels[src_idx * 3 + 2];
            } else {
                a.set_invalid(x, y);
            }
        }
    }
    a
}

/// Build image B from the reference: copy the right 192 columns (of 256),
/// place them at x ∈ [64, 256), zero-pad x ∈ [0, 64), mark padded region invalid.
///
/// Layout: B's content is reference x ∈ [64, 256) placed at x ∈ [64, 256).
/// This means the overlap region is x ∈ [64, 192).
fn make_image_b(reference: &PanoImage) -> PanoImage {
    let w = reference.width;
    let h = reference.height;
    let mut b = PanoImage::new(w, h, reference.color);
    let offset = 64u32; // B starts at x = 64 (source x = 64 in reference)
    for y in 0..h {
        for x in 0..w {
            if x >= offset {
                // x in reference = x (since offset aligns with reference)
                let src_idx = (y as usize) * (w as usize) + (x as usize);
                let dst_idx = src_idx;
                b.pixels[dst_idx * 3] = reference.pixels[src_idx * 3];
                b.pixels[dst_idx * 3 + 1] = reference.pixels[src_idx * 3 + 1];
                b.pixels[dst_idx * 3 + 2] = reference.pixels[src_idx * 3 + 2];
            } else {
                b.set_invalid(x, y);
            }
        }
    }
    b
}

/// Write a `PanoImage` to an 8-bit sRGB PNG (suitable for fixtures used
/// by the harness, since compare_images.py handles 8-bit PNGs fine).
fn write_pano_as_png8(img: &PanoImage, path: &Path) -> Result<(), String> {
    let n_pixels = (img.width as usize) * (img.height as usize);
    let mut buf = vec![0u8; n_pixels * 3];
    for i in 0..n_pixels {
        let base_src = i * 3;
        let r20 = img.pixels[base_src];
        let g20 = img.pixels[base_src + 1];
        let b20 = img.pixels[base_src + 2];
        let (r_lin, g_lin, b_lin) = rec2020_linear_to_srgb_linear(r20, g20, b20);
        buf[i * 3] = (srgb_encode(r_lin) * 255.0 + 0.5) as u8;
        buf[i * 3 + 1] = (srgb_encode(g_lin) * 255.0 + 0.5) as u8;
        buf[i * 3 + 2] = (srgb_encode(b_lin) * 255.0 + 0.5) as u8;
    }
    let file =
        fs::File::create(path).map_err(|e| format!("cannot create {}: {e}", path.display()))?;
    let mut encoder = png::Encoder::new(file, img.width, img.height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Default);
    encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("PNG header error: {e}"))?;
    writer
        .write_image_data(&buf)
        .map_err(|e| format!("PNG data error: {e}"))?;
    Ok(())
}

fn gen_fixtures(dir: &Path) -> Result<(), String> {
    let corpus_dir = dir.join("corpus");
    let refs_dir = dir.join("references");
    fs::create_dir_all(&corpus_dir)
        .map_err(|e| format!("cannot create {}: {e}", corpus_dir.display()))?;
    fs::create_dir_all(&refs_dir)
        .map_err(|e| format!("cannot create {}: {e}", refs_dir.display()))?;

    eprintln!(
        "pano-smoke: generating synthetic fixtures in {}",
        dir.display()
    );

    let reference = make_synthetic_reference(256, 256, 42);
    let img_a = make_image_a(&reference);
    let img_b = make_image_b(&reference);

    let ref_path = refs_dir.join("synthetic.png");
    let a_path = corpus_dir.join("synthetic_a.png");
    let b_path = corpus_dir.join("synthetic_b.png");

    write_pano_as_png8(&reference, &ref_path)?;
    write_pano_as_png8(&img_a, &a_path)?;
    write_pano_as_png8(&img_b, &b_path)?;

    eprintln!("pano-smoke: wrote reference → {}", ref_path.display());
    eprintln!(
        "pano-smoke: wrote corpus/synthetic_a.png → {}",
        a_path.display()
    );
    eprintln!(
        "pano-smoke: wrote corpus/synthetic_b.png → {}",
        b_path.display()
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Stitching pipeline
// ---------------------------------------------------------------------------
//
// Canvas computation + canvas-aware warping live in
// `pano_core::warp::canvas` — the previous local helpers
// `compute_canvas_size` / `warp_to_canvas` returned single-image-sized
// canvases and silently clipped any non-identity rotation.

/// Convert DJI gimbal Euler angles (yaw, pitch, roll in degrees) to a
/// rotation matrix representing the camera's pose in the world frame.
///
/// DJI convention (drone-body frame):
/// - Yaw: rotation around Y axis (up), positive = clockwise viewed from above
/// - Pitch: rotation around X axis, positive = nose up
/// - Roll: rotation around Z axis, positive = right wing up
///
/// We use the aerospace ZYX convention: R = Ryaw * Rpitch * Rroll.
/// Camera 0 is the gauge fix — BA normalises relative to it.
fn gimbal_to_rotation(yaw_deg: f32, pitch_deg: f32, roll_deg: f32) -> nalgebra::Matrix3<f32> {
    let yaw = (yaw_deg as f64).to_radians();
    let pitch = (pitch_deg as f64).to_radians();
    let roll = (roll_deg as f64).to_radians();

    // Ry (yaw about Y axis — horizontal pan)
    let ry = nalgebra::Matrix3::new(
        yaw.cos(),  0.0, yaw.sin(),
        0.0,        1.0, 0.0,
       -yaw.sin(),  0.0, yaw.cos(),
    );
    // Rx (pitch about X axis — tilt)
    let rx = nalgebra::Matrix3::new(
        1.0, 0.0,          0.0,
        0.0, pitch.cos(), -pitch.sin(),
        0.0, pitch.sin(),  pitch.cos(),
    );
    // Rz (roll about Z axis)
    let rz = nalgebra::Matrix3::new(
        roll.cos(), -roll.sin(), 0.0,
        roll.sin(),  roll.cos(), 0.0,
        0.0,         0.0,        1.0,
    );
    (ry * rx * rz).cast::<f32>()
}

/// Build per-camera rotation priors by BFS over pairwise homographies.
///
/// For each pair (i, j) with inlier matches, fits a homography and extracts
/// the rotation. Then chains via BFS from camera 0 to get absolute rotations
/// for all cameras. Used to initialise joint BA before LM refinement.
fn compute_homography_chain_priors(
    pairs: &[(usize, usize, Matches)],
    features: &[Features],
    n_cams: usize,
    image_size: (u32, u32),
) -> Result<Vec<Option<CameraPrior>>, String> {
    use std::collections::VecDeque;

    let focal_fallback = image_size.0.max(image_size.1) as f64;
    let (img_w, img_h) = (image_size.0 as f64, image_size.1 as f64);

    // Edge: (cam_i, cam_j, inlier_count, rotation i→j)
    struct Edge {
        a: usize,
        b: usize,
        weight: i64,
        rotation: nalgebra::Matrix3<f64>,
    }

    let mut edges: Vec<Edge> = Vec::new();
    // Accumulate per-camera focal estimates from each pair that touches that camera.
    let mut focal_estimates: Vec<Vec<f64>> = vec![Vec::new(); n_cams];

    for (ci, cj, matches) in pairs {
        if matches.inliers.len() < 4 {
            continue;
        }
        let kps_i = &features[*ci].keypoints;
        let kps_j = &features[*cj].keypoints;

        let ransac_result = ransac_homography(kps_i, kps_j, &matches.inliers, 5.0, 500, 42);
        let (rotation, focal_est) = if let Some((h, _)) = ransac_result {
            let r = rotation_from_homography(&h, focal_fallback, img_w, img_h);
            let f = focal_from_homography(&h, image_size);
            (r, f)
        } else {
            (nalgebra::Matrix3::identity(), None)
        };

        // Accumulate focal estimates for both cameras in this pair.
        if let Some(f) = focal_est {
            focal_estimates[*ci].push(f);
            focal_estimates[*cj].push(f);
        }

        edges.push(Edge {
            a: *ci,
            b: *cj,
            weight: -(matches.inliers.len() as i64),
            rotation,
        });
    }

    // Compute mean focal per camera; fall back to image_w if no estimates.
    let initial_focals: Vec<f64> = focal_estimates
        .iter()
        .map(|fs| {
            if fs.is_empty() {
                focal_fallback
            } else {
                let mean: f64 = fs.iter().sum::<f64>() / fs.len() as f64;
                mean
            }
        })
        .collect();

    // Log the per-camera focal estimates.
    for (i, f) in initial_focals.iter().enumerate() {
        eprintln!("pano-smoke:   focal_est[{i}]={f:.1}  (fallback={focal_fallback:.1})");
    }

    // Build adjacency list from all edges.
    let mut adj: Vec<Vec<(usize, nalgebra::Matrix3<f64>)>> = vec![Vec::new(); n_cams];
    for edge in &edges {
        adj[edge.a].push((edge.b, edge.rotation));
        adj[edge.b].push((edge.a, edge.rotation.transpose()));
    }

    // BFS from camera 0.
    let mut rotations: Vec<nalgebra::Matrix3<f64>> = vec![nalgebra::Matrix3::identity(); n_cams];
    let mut visited = vec![false; n_cams];
    visited[0] = true;
    let mut queue: VecDeque<usize> = VecDeque::new();
    queue.push_back(0);
    while let Some(cur) = queue.pop_front() {
        for &(nbr, r_edge) in &adj[cur] {
            if !visited[nbr] {
                visited[nbr] = true;
                rotations[nbr] = rotations[cur] * r_edge;
                queue.push_back(nbr);
            }
        }
    }

    let priors: Vec<Option<CameraPrior>> = rotations
        .iter()
        .enumerate()
        .map(|(i, r)| {
            Some(CameraPrior {
                rotation: r.cast::<f64>(),
                focal: initial_focals[i] as f32,
            })
        })
        .collect();

    Ok(priors)
}

fn stitch(inputs: &[PathBuf], output: &Path, _max_dim: u32, projection: Projection) -> Result<(), String> {
    if inputs.len() < 2 {
        return Err(format!(
            "need at least 2 input images, got {}",
            inputs.len()
        ));
    }

    // For 2 images with default (cylindrical) projection, use the existing
    // pair path (no joint-BA overhead).
    if inputs.len() == 2 && matches!(projection, Projection::Cylindrical) {
        let img_a = load_image_any_format(&inputs[0])?;
        let img_b = load_image_any_format(&inputs[1])?;
        let result = stitch_pair(img_a, img_b, 0)?;
        write_stitch(&result, output)?;
        eprintln!("pano-smoke: done.");
        return Ok(());
    }

    // --- N-image joint BA path (Phase 2) ----------------------------------
    //
    // 1. Decode all N inputs.
    // 2. Detect AKAZE features in each image.
    // 3. Match consecutive pairs (0,1), (1,2), ..., (N-2,N-1) via BruteForce
    //    + RANSAC.
    // 4. Single joint BA over all N cameras.
    // 5. Single canvas computation, single warp pass, seam, blend.

    let n = inputs.len();
    eprintln!("pano-smoke: loading {} images (joint BA path)", n);

    // Load images and extract gimbal angles + EXIF focal-in-pixels where available.
    //
    // `focal_pixels` is the per-image focal length already converted to pixels
    // (read from EXIF `FocalLengthIn35mmFormat` or physical `FocalLength` +
    // a sensor-width lookup). When present it replaces the old `image_width`
    // hardcode that was off by ~25–33% on DJI L2D-20c (5376 px image vs.
    // ~3584 px true focal at 24 mm equivalent). That bias was a primary
    // cause of misalignment in pano_01.
    let mut pano_images: Vec<PanoImage> = Vec::with_capacity(n);
    let mut gimbal_priors: Vec<Option<(f32, f32, f32)>> = Vec::with_capacity(n); // (yaw, pitch, roll) degrees
    let mut focal_pixels_per_image: Vec<Option<f32>> = Vec::with_capacity(n);
    let mut distortion_per_image: Vec<Option<(f32, f32)>> = Vec::with_capacity(n);

    for p in inputs {
        eprintln!("pano-smoke:   {}", p.display());
        let bytes = fs::read(p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
        // Try to get gimbal + focal + lens distortion from raw_core for DNGs.
        let (gimbal, focal_px, dist) = if pano_core::ingest::sniff_format(&bytes) == pano_core::ingest::PanoFormat::Raw {
            match raw_core::decode_for_pano(&bytes, "dng") {
                Ok(ingest) => (
                    ingest.gimbal.map(|g| (g.yaw_deg, g.pitch_deg, g.roll_deg)),
                    ingest.focal_pixels,
                    ingest.distortion,
                ),
                Err(_) => (None, None, None),
            }
        } else {
            (None, None, None)
        };
        gimbal_priors.push(gimbal);
        focal_pixels_per_image.push(focal_px);
        distortion_per_image.push(dist);

        let img = pano_core::decode_bytes(&bytes)
            .map_err(|e| format!("decode failed for {}: {e}", p.display()))?;
        pano_images.push(img);
    }

    let image_size = {
        let w = pano_images.iter().map(|i| i.width).min().unwrap_or(0);
        let h = pano_images.iter().map(|i| i.height).min().unwrap_or(0);
        (w, h)
    };

    // --- 2. Detect features -----------------------------------------------
    eprintln!("pano-smoke: detecting features in {} images", n);
    let detector = AkazeDetector::default();
    let all_features: Vec<Features> = pano_images
        .iter()
        .enumerate()
        .map(|(i, img)| {
            let f = detector
                .detect(img)
                .map_err(|e| format!("detect on image {i} failed: {e}"))?;
            eprintln!("pano-smoke:   image[{i}]: {} kps", f.keypoints.len());
            Ok(f)
        })
        .collect::<Result<Vec<_>, String>>()?;

    // --- 3. Match consecutive pairs: loose BF → GMS → gimbal filter → RANSAC -
    //
    // GMS (Bian et al. 2017) filters by spatial-motion-consistency, which
    // discards the zero-displacement matches that high-overlap consecutive
    // panorama frames produce when the descriptor matcher prefers
    // matching-self over matching-rotated. We feed BF a loose Lowe ratio
    // (0.95) so the population GMS has to score is large enough.
    //
    // GMS alone leaks zero-displacement matches when overlap is high enough
    // that the zero-shift cluster is internally motion-consistent (everything
    // moves by Δ = 0 uniformly). The gimbal filter closes that gap: it
    // rejects matches whose observed shift disagrees with the gimbal-predicted
    // homography by more than a tolerance ball (default 100 px ≈ 1.5° angular
    // error budget on a 3584-px focal).  Only runs when both images of the
    // pair have gimbal data.
    eprintln!(
        "pano-smoke: loose BF → GMS → (gimbal filter when available) → RANSAC over {} consecutive pairs",
        n - 1
    );
    let gimbal_tol_px: f64 = 100.0;
    let cx_image = image_size.0 as f64 / 2.0;
    let cy_image = image_size.1 as f64 / 2.0;
    let matcher = BruteForceMatcher::new(0.95, false);
    let mut pairs: Vec<(usize, usize, Matches)> = Vec::new();
    let mut min_pair_inliers: usize = usize::MAX;

    for i in 0..(n - 1) {
        let j = i + 1;
        let raw = matcher
            .match_pairs(&all_features[i], &all_features[j])
            .map_err(|e| format!("matching pair ({i},{j}) failed: {e}"))?;

        let gms = gms_filter(
            &raw,
            &all_features[i],
            &all_features[j],
            image_size,
            image_size,
            20,
            6.0,
        );

        eprintln!(
            "pano-smoke:   pair ({i},{j}): {} raw → {} GMS",
            raw.inliers.len(),
            gms.inliers.len()
        );

        // Gimbal-aware filter: only when both images of this pair have
        // gimbal data AND a per-image EXIF focal. Otherwise pass GMS
        // through unchanged.
        let gimbal_filtered: Matches =
            if let (Some((y_i, p_i, r_i)), Some((y_j, p_j, r_j)), Some(f_i), Some(f_j)) = (
                gimbal_priors[i],
                gimbal_priors[j],
                focal_pixels_per_image[i],
                focal_pixels_per_image[j],
            ) {
                let r_a = gimbal_to_rotation(y_i, p_i, r_i).cast::<f64>();
                let r_b = gimbal_to_rotation(y_j, p_j, r_j).cast::<f64>();
                let h_pred = predicted_homography(
                    &r_a,
                    f_i as f64,
                    &r_b,
                    f_j as f64,
                    (cx_image, cy_image),
                );
                let kept = gimbal_filter(
                    &gms,
                    &all_features[i],
                    &all_features[j],
                    &h_pred,
                    gimbal_tol_px,
                );
                eprintln!(
                    "pano-smoke:   pair ({i},{j}): GMS {} → gimbal-filter {} (tol={gimbal_tol_px:.0} px)",
                    gms.inliers.len(),
                    kept.inliers.len()
                );
                kept
            } else {
                gms.clone()
            };

        let ransac_input = if gimbal_filtered.inliers.len() >= 8 {
            &gimbal_filtered
        } else if gms.inliers.len() >= 8 {
            // Gimbal filter too aggressive (tolerance too tight or gimbal
            // priors too far off) — fall back to GMS-only.
            eprintln!(
                "pano-smoke:   pair ({i},{j}): gimbal filter kept {} — falling back to GMS-only",
                gimbal_filtered.inliers.len()
            );
            &gms
        } else {
            // GMS too aggressive — fall back to the pre-GMS population so
            // RANSAC at least sees something. This is the "very low overlap
            // or pure-translation" failure mode; a downstream decision will
            // route to gimbal-direct if necessary.
            eprintln!(
                "pano-smoke:   pair ({i},{j}): GMS kept {} — falling back to raw matches for RANSAC",
                gms.inliers.len()
            );
            &raw
        };

        if ransac_input.inliers.len() < 8 {
            eprintln!(
                "pano-smoke:   WARNING pair ({i},{j}) has only {} matches — skipping RANSAC",
                ransac_input.inliers.len()
            );
            pairs.push((i, j, ransac_input.clone()));
            min_pair_inliers = min_pair_inliers.min(ransac_input.inliers.len());
            continue;
        }

        let ransac_result = ransac_homography(
            &all_features[i].keypoints,
            &all_features[j].keypoints,
            &ransac_input.inliers,
            3.0,
            2000,
            42,
        );

        let inlier_matches = if let Some((_, inlier_idxs)) = ransac_result {
            eprintln!(
                "pano-smoke:   pair ({i},{j}): RANSAC inliers={}/{}",
                inlier_idxs.len(),
                ransac_input.inliers.len()
            );
            Matches {
                inliers: inlier_idxs.iter().map(|&k| ransac_input.inliers[k]).collect(),
            }
        } else {
            eprintln!("pano-smoke:   WARNING pair ({i},{j}): RANSAC failed — using GMS matches");
            ransac_input.clone()
        };
        min_pair_inliers = min_pair_inliers.min(inlier_matches.inliers.len());
        pairs.push((i, j, inlier_matches));
    }

    // --- 4. Camera pose estimation -----------------------------------------
    //
    // For DJI inputs (gimbal angles available for every image) we run joint
    // BA seeded from gimbal priors with a strong rotation soft-prior penalty.
    // This is the result of Steps 1-4 of the right-way fix:
    //
    // - Step 1 (EXIF focal): the focal_prior is now correct (~3584 px on
    //   DJI L2D-20c, not the 5376 image-width hardcode that was off by ~33%).
    // - Step 2 (gimbal-aware match filter): GMS leaks zero-displacement
    //   matches when the zero-shift cluster is internally motion-consistent.
    //   We project each match's expected pixel via the gimbal-predicted
    //   homography and reject any match outside a 100 px tolerance ball.
    //   That collapses the bogus 12K identity-driven RANSAC inliers to a
    //   few hundred genuinely-rotated matches per pair.
    // - Step 4 (rotation soft prior): with clean matches, BA can usefully
    //   refine each camera's rotation. The soft prior `λ · |ω − ω_gimbal|²`
    //   keeps each rotation close to the gimbal estimate; the matches pull
    //   it slightly toward pixel-accurate alignment. This catches gimbal
    //   drift / mechanical play that the hardware can't self-report.
    //
    // The earlier "gimbal-direct" path is preserved as a fallback when BA
    // fails (e.g. all pairs have <8 inliers after gimbal filter).
    let has_all_gimbal = gimbal_priors.iter().all(|g| g.is_some());

    // Derive the focal-pixel prior from EXIF when available.
    //
    // We use the median of the per-image EXIF focals — robust against any
    // single-image read failure and against minor firmware-rounding jitter
    // (DJI sometimes writes the 35 mm-equivalent focal as an integer that
    // rounds to one of two values across a single panorama burst). When
    // no EXIF focal is available for any image we fall back to the old
    // image-dimension prior so synthetic / hand-cropped tests still work.
    let exif_focals: Vec<f32> = focal_pixels_per_image
        .iter()
        .filter_map(|f| f.map(|x| x as f32))
        .collect();
    let focal_prior: f32 = if !exif_focals.is_empty() {
        let mut sorted = exif_focals.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = sorted[sorted.len() / 2];
        eprintln!(
            "pano-smoke: focal_prior={median:.1} px (median of {} EXIF reads; \
             image_size hardcode would have been {:.1})",
            exif_focals.len(),
            image_size.0.max(image_size.1) as f32
        );
        median
    } else {
        let f = image_size.0.max(image_size.1) as f32;
        eprintln!(
            "pano-smoke: focal_prior={f:.1} px (no EXIF focal in any input — \
             falling back to image_size.max)"
        );
        f
    };
    let _ = min_pair_inliers; // surfaced via per-pair logs above; not used for routing

    // Helper: compute relative gimbal rotation for camera `i` (cam 0 is the
    // gauge — its rotation is identity).
    let compute_relative_gimbal = |gimbal_priors: &[Option<(f32, f32, f32)>], i: usize| -> Option<nalgebra::Matrix3<f32>> {
        let r0 = gimbal_priors[0].as_ref().map(|(y, p, r)| gimbal_to_rotation(*y, *p, *r))?;
        let (y, p, r) = gimbal_priors[i]?;
        let r_abs = gimbal_to_rotation(y, p, r);
        Some(r0.transpose() * r_abs)
    };

    let cameras: Vec<Camera> = if has_all_gimbal {
        eprintln!(
            "pano-smoke: BA-with-rotation-soft-prior (DJI input; \
             λ_rot=33000 anchor on gimbal, focal anchor at EXIF prior)"
        );

        // Build per-camera priors from gimbal angles + EXIF focal.
        let priors: Vec<Option<CameraPrior>> = (0..n)
            .map(|i| {
                let r_rel = compute_relative_gimbal(&gimbal_priors, i)?;
                let omega = rodrigues_log(&r_rel.cast::<f64>());
                let deg = omega.norm().to_degrees();
                let focal_i = focal_pixels_per_image[i].unwrap_or(focal_prior);
                eprintln!(
                    "pano-smoke:   gimbal_prior[{i}] omega_deg={deg:.1}  focal={focal_i:.1}",
                );
                Some(CameraPrior {
                    rotation: r_rel.cast::<f64>(),
                    focal: focal_i,
                })
            })
            .collect();

        let ba_config = JointRotationFocalBA {
            max_iters: 200,
            step_tolerance: 1e-6,
            // 1° rotation drift from prior contributes ~3.16 px-equivalent
            // residual per axis (~30 px across 3 axes per camera). Strong
            // enough to dominate any residual zero-displacement signal that
            // slipped past the gimbal filter, weak enough to let cleanly
            // matched features pull each rotation by ≪1° if they
            // consistently disagree with the gimbal.
            lambda_rotation: 33_000.0,
            // Focal: keep within ~1% of prior. λ_f=10000 means a 1% drift
            // adds ~10 px-equivalent residual per camera.
            lambda_focal: 10_000.0,
        };

        let mut cams = match solve_joint_with_priors(
            &all_features,
            &pairs,
            image_size,
            Some(&priors),
            &ba_config,
        ) {
            Ok(cams) => cams,
            Err(e) => {
                // BA failed (no usable correspondences). Fall back to
                // gimbal-direct so the pipeline still produces output.
                eprintln!(
                    "pano-smoke: BA failed ({e}) — falling back to gimbal-direct"
                );
                priors
                    .iter()
                    .map(|p| {
                        let prior = p.unwrap();
                        Camera {
                            focal: prior.focal,
                            rotation: prior.rotation.cast::<f32>(),
                            distortion: pano_core::types::Distortion::default(),
                        }
                    })
                    .collect::<Vec<_>>()
            }
        };

        // Attach per-image lens distortion (read from DNG WarpRectilinear).
        // BA does not optimise distortion; the values come straight from
        // the DNG's lens profile and are passed through to the warper.
        for (i, cam) in cams.iter_mut().enumerate() {
            if let Some((k1, k2)) = distortion_per_image[i] {
                cam.distortion = pano_core::types::Distortion { k1, k2 };
                eprintln!(
                    "pano-smoke:   cam[{i}] distortion k1={k1:.4}  k2={k2:.4}",
                );
            }
        }
        cams
    } else {
        eprintln!("pano-smoke: GMS-filtered joint BA with homography-chain priors");
        let priors = compute_homography_chain_priors(&pairs, &all_features, n, image_size)?;
        for (i, p) in priors.iter().enumerate() {
            if let Some(prior) = p {
                let omega = rodrigues_log(&prior.rotation);
                let deg = omega.norm().to_degrees();
                eprintln!(
                    "pano-smoke:   prior[{i}] omega_deg={deg:.1}  focal={:.1}",
                    prior.focal
                );
            }
        }
        let ba_config = JointRotationFocalBA {
            max_iters: 200,
            step_tolerance: 1e-6,
            lambda_rotation: 0.0,
            lambda_focal: 0.0,
        };
        solve_joint_with_priors(
            &all_features,
            &pairs,
            image_size,
            Some(&priors),
            &ba_config,
        )
        .map_err(|e| format!("joint BA failed: {e}"))?
    };

    for (i, cam) in cameras.iter().enumerate() {
        let r = cam.rotation;
        // Print rotation as approximate yaw (atan2 of R[0][2], R[2][2]).
        let yaw_deg = r[(0, 2)].atan2(r[(2, 2)]).to_degrees();
        // Also print the axis-angle to see the full rotation.
        use pano_core::ba::joint::rodrigues_log;
        let omega = rodrigues_log(&r.cast::<f64>());
        let omega_deg = omega.norm().to_degrees();
        eprintln!(
            "pano-smoke:   cam[{i}] focal={:.1}  approx_yaw={:.1}°  omega_deg={:.1}°  R[0..2]=[{:.3},{:.3},{:.3}]",
            cam.focal, yaw_deg, omega_deg,
            r[(0, 0)], r[(0, 1)], r[(0, 2)]
        );
    }

    // --- 5. Canvas + warp + seam + blend ------------------------------------
    eprintln!("pano-smoke: computing canvas");
    let img_refs: Vec<&PanoImage> = pano_images.iter().collect();
    let canvas =
        pano_core::warp::compute_canvas(&img_refs, &cameras, projection)
            .map_err(|e| format!("compute_canvas failed: {e}"))?;
    eprintln!(
        "pano-smoke:   canvas {}×{} ({:?})",
        canvas.width, canvas.height, projection
    );

    eprintln!("pano-smoke: warping {} images", n);
    let warper = CpuWarper::new();
    let mut warped: Vec<PanoImage> = pano_images
        .iter()
        .zip(cameras.iter())
        .enumerate()
        .map(|(i, (img, cam))| {
            let w = pano_core::warp::warp_image_to_canvas(&warper, img, cam, &canvas)
                .map_err(|e| format!("warp image {i} failed: {e}"))?;
            eprintln!(
                "pano-smoke:   warped[{i}] valid_px={}",
                w.validity.count_ones()
            );
            Ok(w)
        })
        .collect::<Result<Vec<_>, String>>()?;

    // --- Gain compensation -------------------------------------------------
    // Solve per-image gain from overlap brightness before seam finding so
    // brightness banding at seams is minimised.
    // Collect gains with immutable refs first, then apply with mutable refs.
    let gain_result = {
        let warped_refs: Vec<&PanoImage> = warped.iter().collect();
        pano_core::compensation::gain::solve_per_image_gain(&warped_refs)
    };
    match gain_result {
        Ok(gains) => {
            eprintln!("pano-smoke: gains = {:?}", gains);
            let _ = pano_core::compensation::gain::apply_gains(&mut warped, &gains);
        }
        Err(e) => {
            eprintln!("pano-smoke: gain compensation skipped ({e})");
        }
    }

    // Single-pass N-way blend (replaces the prior chained pairwise blend).
    // The chain blew its working set across N=21 frames on a 180 MP canvas:
    // each step rebuilt a full pyramid pair, peaking at ~17 GB. The streaming
    // accumulator in MultiBandBlender::blend_n processes one image at a time,
    // dropping each pyramid before the next is allocated, so peak memory is
    // ~2× canvas regardless of N.
    eprintln!(
        "pano-smoke: building per-image partition masks ({} images)",
        warped.len()
    );
    let weight_masks = build_partition_masks(&warped);

    eprintln!("pano-smoke: streaming N-way blend");
    let blender = pano_core::MultiBandBlender::default();
    let warped_refs: Vec<&PanoImage> = warped.iter().collect();
    let result = blender
        .blend_n(&warped_refs, &weight_masks)
        .map_err(|e| format!("blend_n failed: {e}"))?;

    write_stitch(&result, output)?;
    eprintln!("pano-smoke: done.");
    Ok(())
}

/// Build a per-image weight mask for streaming N-way blend.
///
/// Voronoi-style: each canvas pixel goes to whichever image is valid at
/// that location and whose footprint center is closest. Weights are then
/// normalised per-pixel so they partition unity (Σ_i weight_i = 1.0 at
/// every pixel that has at least one valid input).
///
/// Pixels where NO image is valid get 0.0 across all masks — the
/// resulting RGB is undefined; the output's validity bitmap (set by
/// blend_n) marks them as invalid.
///
/// Quality vs computed graph-cut seams: this is a soft Voronoi
/// partition, so seams pass through whatever happens to be at the
/// midpoint between two images' centers. Good enough for the MVP;
/// graph-cut N-way seams are a follow-up that plugs into the same
/// `weight_masks` parameter shape.
fn build_partition_masks(warped: &[PanoImage]) -> Vec<Vec<f32>> {
    let n = warped.len();
    if n == 0 {
        return Vec::new();
    }
    let w = warped[0].width;
    let h = warped[0].height;
    let n_pixels = (w as usize) * (h as usize);

    // Compute each warped image's footprint center (mean of valid pixel
    // coords). For images with no valid pixels (shouldn't happen post-warp
    // but guard anyway), use the canvas center.
    let mut centers: Vec<(f32, f32)> = Vec::with_capacity(n);
    for img in warped {
        let mut sx = 0.0_f64;
        let mut sy = 0.0_f64;
        let mut count = 0u64;
        for y in 0..h {
            for x in 0..w {
                let idx = (y * w + x) as usize;
                if img.validity[idx] {
                    sx += x as f64;
                    sy += y as f64;
                    count += 1;
                }
            }
        }
        if count > 0 {
            centers.push(((sx / count as f64) as f32, (sy / count as f64) as f32));
        } else {
            centers.push((w as f32 / 2.0, h as f32 / 2.0));
        }
    }

    // For each pixel: if image i is valid there, weight_i ∝ 1 / (1 + dist²)
    // where dist is the canvas-pixel distance to image i's center. Then
    // normalise so Σ_i weight_i = 1.0.
    let mut masks: Vec<Vec<f32>> = (0..n).map(|_| vec![0.0_f32; n_pixels]).collect();

    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            // First pass: raw inverse-square weights for valid images.
            let mut total = 0.0_f32;
            for i in 0..n {
                if warped[i].validity[idx] {
                    let dx = x as f32 - centers[i].0;
                    let dy = y as f32 - centers[i].1;
                    let d2 = dx * dx + dy * dy;
                    let w_raw = 1.0 / (1.0 + d2);
                    masks[i][idx] = w_raw;
                    total += w_raw;
                }
            }
            // Normalise to sum to 1.0.
            if total > 1e-12 {
                for i in 0..n {
                    masks[i][idx] /= total;
                }
            }
        }
    }

    masks
}

fn write_stitch(result: &PanoImage, output: &Path) -> Result<(), String> {
    eprintln!("pano-smoke:   output {}×{}", result.width, result.height);
    eprintln!("pano-smoke: writing {}", output.display());
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create output dir {}: {e}", parent.display()))?;
        }
    }
    write_pano_image_as_png16(result, output)
}

fn stitch_pair(img_a: PanoImage, img_b: PanoImage, step: usize) -> Result<PanoImage, String> {
    let _ = step;
    // BA needs a single (width, height) hint for its focal-length prior;
    // use the smaller of the two inputs so the prior stays in a sane
    // range when chain stitching mixes a wide canvas with a narrow image.
    let image_size = (img_a.width.min(img_b.width), img_a.height.min(img_b.height));

    // --- 2. Detect features ------------------------------------------------
    eprintln!("pano-smoke: detecting features");
    let detector = AkazeDetector::default();
    let feats_a = detector
        .detect(&img_a)
        .map_err(|e| format!("detect on image A failed: {e}"))?;
    let feats_b = detector
        .detect(&img_b)
        .map_err(|e| format!("detect on image B failed: {e}"))?;

    eprintln!(
        "pano-smoke:   A={} kps, B={} kps",
        feats_a.keypoints.len(),
        feats_b.keypoints.len()
    );

    if feats_a.keypoints.len() < 8 || feats_b.keypoints.len() < 8 {
        return Err(format!(
            "insufficient keypoints: A={}, B={} (need ≥8 each)",
            feats_a.keypoints.len(),
            feats_b.keypoints.len()
        ));
    }

    // --- 3. Match ----------------------------------------------------------
    eprintln!("pano-smoke: matching features");
    let matcher = BruteForceMatcher::default();
    let matches = matcher
        .match_pairs(&feats_a, &feats_b)
        .map_err(|e| format!("matching failed: {e}"))?;

    eprintln!("pano-smoke:   {} matches", matches.inliers.len());

    if matches.inliers.len() < 8 {
        eprintln!(
            "pano-smoke: WARNING: only {} matches (need ≥8 for RANSAC); \
             proceeding with identity cameras",
            matches.inliers.len()
        );
    }

    // --- 4. RANSAC homography ----------------------------------------------
    // --- 5. solve_with_keypoints BA ----------------------------------------
    let cameras: Vec<Camera> = if matches.inliers.len() >= 8 {
        eprintln!("pano-smoke: running homography + BA");

        // Attempt RANSAC + solve_with_keypoints.
        let (h, inlier_idxs) = ransac_homography(
            &feats_a.keypoints,
            &feats_b.keypoints,
            &matches.inliers,
            3.0,
            2000,
            42,
        )
        .ok_or_else(|| "RANSAC failed to find a homography".to_string())?;

        eprintln!(
            "pano-smoke:   RANSAC inliers={}/{}",
            inlier_idxs.len(),
            matches.inliers.len()
        );

        // Build a Matches struct from the RANSAC inliers for solve_with_keypoints.
        let ransac_matches = Matches {
            inliers: inlier_idxs.iter().map(|&i| matches.inliers[i]).collect(),
        };

        let pairs = vec![(
            0usize,
            1usize,
            ransac_matches,
            feats_a.keypoints.clone(),
            feats_b.keypoints.clone(),
        )];

        let _ = h; // RANSAC result used for inlier selection above.

        solve_with_keypoints(2, &pairs, image_size, 42)
            .map_err(|e| format!("bundle adjustment failed: {e}"))?
    } else {
        // Fallback: identity cameras — still run the rest of the pipeline.
        vec![
            Camera {
                focal: image_size.0.max(image_size.1) as f32,
                rotation: nalgebra::Matrix3::identity(),
                distortion: pano_core::types::Distortion::default(),
            },
            Camera {
                focal: image_size.0.max(image_size.1) as f32,
                rotation: nalgebra::Matrix3::identity(),
                distortion: pano_core::types::Distortion::default(),
            },
        ]
    };

    eprintln!(
        "pano-smoke:   cam[0] focal={:.1}  cam[1] focal={:.1}",
        cameras[0].focal, cameras[1].focal
    );

    // --- 6. Warp -----------------------------------------------------------
    eprintln!("pano-smoke: warping images");
    let warper = CpuWarper::new();

    // Cylindrical canvas sized to the union of both images' projected
    // footprints — see pano-core::warp::canvas. The previous
    // compute_canvas_size returned max(input dims) and silently clipped
    // any pixel pushed outside the input bbox by a non-identity rotation.
    let canvas =
        pano_core::warp::compute_canvas(&[&img_a, &img_b], &cameras, Projection::Cylindrical)
            .map_err(|e| format!("compute_canvas failed: {e}"))?;
    eprintln!(
        "pano-smoke:   canvas {}×{} (cylindrical)",
        canvas.width, canvas.height
    );

    let mut warped_a = pano_core::warp::warp_image_to_canvas(&warper, &img_a, &cameras[0], &canvas)
        .map_err(|e| format!("warp A failed: {e}"))?;
    let mut warped_b = pano_core::warp::warp_image_to_canvas(&warper, &img_b, &cameras[1], &canvas)
        .map_err(|e| format!("warp B failed: {e}"))?;

    // Count valid pixels for diagnostic output.
    let valid_a = warped_a.validity.count_ones();
    let valid_b = warped_b.validity.count_ones();
    eprintln!("pano-smoke:   warped A valid_px={valid_a}  warped B valid_px={valid_b}");

    // --- Gain compensation ------------------------------------------------
    // Apply before seam finding so brightness banding at seams is minimised.
    // Collect gains with immutable refs first, then apply with mutable refs.
    {
        let mut pair = [warped_a, warped_b];
        let gain_result = {
            let pair_refs: Vec<&PanoImage> = pair.iter().collect();
            pano_core::compensation::gain::solve_per_image_gain(&pair_refs)
        };
        match gain_result {
            Ok(gains) => {
                eprintln!("pano-smoke: gains = {:?}", gains);
                let _ = pano_core::compensation::gain::apply_gains(&mut pair, &gains);
            }
            Err(e) => {
                eprintln!("pano-smoke: gain compensation skipped ({e})");
            }
        }
        let [wa, wb] = pair;
        warped_a = wa;
        warped_b = wb;
    }

    // --- 7. Seam finding ---------------------------------------------------
    eprintln!("pano-smoke: finding seams");
    // BK max-flow seam finder by default.
    let seam_finder = GraphCutMaxFlowSeamFinder::new();
    let seams = seam_finder
        .seams(&[&warped_a, &warped_b])
        .map_err(|e| format!("seam finding failed: {e}"))?;

    // --- 8. Blend ----------------------------------------------------------
    eprintln!("pano-smoke: blending");
    let blender = pano_core::MultiBandBlender::default();
    blender
        .blend(&[&warped_a, &warped_b], &seams)
        .map_err(|e| format!("blending failed: {e}"))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() {
    let cli = Cli::parse();

    let result = if let Some(dir) = &cli.gen_fixtures {
        gen_fixtures(dir)
    } else {
        // Stitch mode.
        let output = cli
            .output
            .clone()
            .unwrap_or_else(|| PathBuf::from("panorama.png"));
        let projection = match cli.projection.to_ascii_lowercase().as_str() {
            "spherical" => Projection::Spherical,
            "rectilinear" => Projection::Rectilinear,
            _ => Projection::Cylindrical,
        };
        stitch(&cli.inputs, &output, cli.max_dim, projection)
    };

    if let Err(e) = result {
        eprintln!("pano-smoke: ERROR: {e}");
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------------------
// Unit tests for helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use pano_core::ColorSpace;

    // --- color round-trip tests -------------------------------------------

    #[test]
    fn srgb_encode_decode_roundtrip() {
        for v in [0.0f32, 0.01, 0.1, 0.5, 0.9, 1.0] {
            let encoded = srgb_encode(v);
            let decoded = srgb_decode(encoded);
            assert!(
                (decoded - v).abs() < 1e-5,
                "sRGB roundtrip failed for {v}: got {decoded}"
            );
        }
    }

    #[test]
    fn srgb_encode_clamps_input() {
        assert_eq!(srgb_encode(-0.1), srgb_encode(0.0));
        assert_eq!(srgb_encode(1.5), srgb_encode(1.0));
    }

    #[test]
    fn rec2020_srgb_roundtrip() {
        // Test that sRGB → Rec.2020 → sRGB is identity.
        for (r, g, b) in [(0.2f32, 0.5, 0.8), (1.0, 1.0, 1.0), (0.0, 0.0, 0.0)] {
            let (r20, g20, b20) = srgb_linear_to_rec2020_linear(r, g, b);
            let (rs, gs, bs) = rec2020_linear_to_srgb_linear(r20, g20, b20);
            assert!((rs - r).abs() < 1e-4, "R roundtrip: {rs} vs {r}");
            assert!((gs - g).abs() < 1e-4, "G roundtrip: {gs} vs {g}");
            assert!((bs - b).abs() < 1e-4, "B roundtrip: {bs} vs {b}");
        }
    }

    #[test]
    fn srgb_to_rec2020_preserves_white() {
        // sRGB (1,1,1) should map to Rec.2020 (1,1,1) — both are normalised to D65.
        let (r20, g20, b20) = srgb_linear_to_rec2020_linear(1.0, 1.0, 1.0);
        assert!((r20 - 1.0).abs() < 1e-3, "R white point: {r20}");
        assert!((g20 - 1.0).abs() < 1e-3, "G white point: {g20}");
        assert!((b20 - 1.0).abs() < 1e-3, "B white point: {b20}");
    }

    // --- PNG roundtrip test -----------------------------------------------

    #[test]
    fn png16_write_read_roundtrip() {
        // Build a small PanoImage in Rec.2020 with neutral grey values (equal
        // R=G=B) so that the Rec.2020 ↔ sRGB matrix doesn't create
        // cross-channel error we'd be measuring by checking the individual
        // channels against their Rec.2020 originals.
        let w = 4u32;
        let h = 4u32;
        let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        for y in 0..h {
            for x in 0..w {
                // Equal-channel grey values in Rec.2020 linear.
                // These are already in sRGB linear too (D65 white maps to
                // itself), so the round-trip is stable.
                let v = (x + y * w) as f32 / ((w * h) as f32) * 0.8 + 0.1;
                let base = (y as usize * w as usize + x as usize) * 3;
                img.pixels[base] = v;
                img.pixels[base + 1] = v;
                img.pixels[base + 2] = v;
            }
        }

        let tmp = std::env::temp_dir().join("pano_smoke_roundtrip_test.png");
        write_pano_image_as_png16(&img, &tmp).expect("write should succeed");

        // Read back using our own loader.
        let read_back = load_png_as_pano_image(&tmp).expect("read should succeed");

        assert_eq!(read_back.width, w);
        assert_eq!(read_back.height, h);

        // For neutral greys, the Rec.2020 ↔ sRGB matrices are identity-like,
        // so round-trip error comes only from sRGB quantisation (u16 + gamma).
        // Tolerance 1% of [0,1] covers the worst-case gamma + u16 loss.
        for i in 0..(w * h) as usize {
            let orig_r = img.pixels[i * 3];
            let orig_g = img.pixels[i * 3 + 1];
            let orig_b = img.pixels[i * 3 + 2];
            let read_r = read_back.pixels[i * 3];
            let read_g = read_back.pixels[i * 3 + 1];
            let read_b = read_back.pixels[i * 3 + 2];
            assert!(
                (read_r - orig_r).abs() < 0.01,
                "R mismatch at {i}: {read_r} vs {orig_r}"
            );
            assert!(
                (read_g - orig_g).abs() < 0.01,
                "G mismatch at {i}: {read_g} vs {orig_g}"
            );
            assert!(
                (read_b - orig_b).abs() < 0.01,
                "B mismatch at {i}: {read_b} vs {orig_b}"
            );
        }

        let _ = std::fs::remove_file(&tmp);
    }

    // --- fixture generation tests -----------------------------------------

    #[test]
    fn synthetic_reference_has_correct_dimensions() {
        let img = make_synthetic_reference(256, 256, 42);
        assert_eq!(img.width, 256);
        assert_eq!(img.height, 256);
        assert_eq!(img.pixels.len(), 256 * 256 * 3);
    }

    #[test]
    fn synthetic_reference_has_nonzero_content() {
        let img = make_synthetic_reference(256, 256, 42);
        let mean: f32 = img.pixels.iter().sum::<f32>() / img.pixels.len() as f32;
        assert!(mean > 0.01, "expected non-trivial content, mean={mean}");
    }

    #[test]
    fn image_a_invalid_region_correct() {
        let reference = make_synthetic_reference(256, 256, 42);
        let a = make_image_a(&reference);
        assert_eq!(a.width, 256);
        // All pixels at x >= 192 must be invalid.
        for y in 0..256 {
            for x in 192..256 {
                assert!(!a.is_valid(x, y), "pixel ({x},{y}) in A should be invalid");
            }
        }
        // Pixels at x < 192 must be valid.
        assert!(a.is_valid(0, 0), "pixel (0,0) in A should be valid");
        assert!(a.is_valid(191, 0), "pixel (191,0) in A should be valid");
    }

    #[test]
    fn image_b_invalid_region_correct() {
        let reference = make_synthetic_reference(256, 256, 42);
        let b = make_image_b(&reference);
        assert_eq!(b.width, 256);
        // All pixels at x < 64 must be invalid.
        for y in 0..256 {
            for x in 0..64 {
                assert!(!b.is_valid(x, y), "pixel ({x},{y}) in B should be invalid");
            }
        }
        // Pixels at x >= 64 must be valid.
        assert!(b.is_valid(64, 0), "pixel (64,0) in B should be valid");
        assert!(b.is_valid(255, 0), "pixel (255,0) in B should be valid");
    }

    #[test]
    fn overlap_region_content_matches_reference() {
        let reference = make_synthetic_reference(256, 256, 42);
        let a = make_image_a(&reference);
        let b = make_image_b(&reference);
        // In the overlap [64, 192) both A and B should carry reference pixels.
        for x in 64u32..192 {
            let y = 128u32;
            let ref_idx = (y as usize) * 256 + (x as usize);
            let a_idx = ref_idx;
            let b_idx = ref_idx;
            assert!(
                (a.pixels[a_idx * 3] - reference.pixels[ref_idx * 3]).abs() < 1e-6,
                "A pixel ({x},{y}) doesn't match reference"
            );
            assert!(
                (b.pixels[b_idx * 3] - reference.pixels[ref_idx * 3]).abs() < 1e-6,
                "B pixel ({x},{y}) doesn't match reference"
            );
        }
    }

    #[test]
    fn gen_fixtures_creates_files() {
        let dir = std::env::temp_dir().join("pano_smoke_fixtures_test");
        let _ = std::fs::remove_dir_all(&dir);
        gen_fixtures(&dir).expect("gen_fixtures should succeed");
        assert!(dir.join("corpus/synthetic_a.png").exists());
        assert!(dir.join("corpus/synthetic_b.png").exists());
        assert!(dir.join("references/synthetic.png").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

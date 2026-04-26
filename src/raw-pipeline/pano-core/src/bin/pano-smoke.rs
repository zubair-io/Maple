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
    ba::{homography::ransac_homography, lm::solve_with_keypoints},
    features::OrbDetector,
    matching::BruteForceMatcher,
    types::{Camera, PanoImage},
    Blender, ColorSpace, CpuWarper, FeatureDetector, FeatureMatcher, GraphCutSeamFinder, Matches,
    Projection, SeamFinder, Warper,
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

/// Place two `PanoImage`s (assumed to be the same size for the MVP) onto a
/// shared canvas.  For the 2-image case this is identity — the warper already
/// produces same-size output.  Returns (canvas_width, canvas_height).
fn compute_canvas_size(images: &[&PanoImage]) -> (u32, u32) {
    let w = images.iter().map(|i| i.width).max().unwrap_or(0);
    let h = images.iter().map(|i| i.height).max().unwrap_or(0);
    (w, h)
}

/// Warp an image onto a canvas of the given size.
///
/// For the identity camera (rotation = I), the image sits at its original
/// position.  The output canvas is padded with invalid pixels outside the
/// warped footprint.
fn warp_to_canvas(
    warper: &CpuWarper,
    img: &PanoImage,
    cam: &Camera,
    canvas_w: u32,
    canvas_h: u32,
) -> Result<PanoImage, String> {
    // The warper produces same-size output.  If the canvas is larger, we'd need
    // to composite — for the MVP, canvas == input size, so this is a simple warp.
    let warped = warper
        .warp(img, cam, Projection::Rectilinear)
        .map_err(|e| format!("warp failed: {e}"))?;

    // If the canvas is the same size as the warped output, we're done.
    if warped.width == canvas_w && warped.height == canvas_h {
        return Ok(warped);
    }

    // Otherwise, embed into canvas (zero-pad).
    let mut canvas = PanoImage::new(canvas_w, canvas_h, img.color);
    for i in 0..(canvas_w as usize * canvas_h as usize) {
        canvas.validity.set(i, false);
    }
    let copy_w = warped.width.min(canvas_w) as usize;
    let copy_h = warped.height.min(canvas_h) as usize;
    for y in 0..copy_h {
        for x in 0..copy_w {
            let si = y * (warped.width as usize) + x;
            let di = y * (canvas_w as usize) + x;
            canvas.pixels[di * 3] = warped.pixels[si * 3];
            canvas.pixels[di * 3 + 1] = warped.pixels[si * 3 + 1];
            canvas.pixels[di * 3 + 2] = warped.pixels[si * 3 + 2];
            if warped.validity[si] {
                canvas.validity.set(di, true);
            }
        }
    }
    Ok(canvas)
}

fn stitch(inputs: &[PathBuf], output: &Path, _max_dim: u32) -> Result<(), String> {
    if inputs.len() < 2 {
        return Err(format!(
            "need at least 2 input images, got {}",
            inputs.len()
        ));
    }
    if inputs.len() > 8 {
        return Err(format!("at most 8 inputs supported, got {}", inputs.len()));
    }

    // --- 1. Load images ----------------------------------------------------
    eprintln!("pano-smoke: loading {} images", inputs.len());
    let pano_images: Vec<PanoImage> = inputs
        .iter()
        .map(|p| {
            eprintln!("pano-smoke:   {}", p.display());
            load_image_any_format(p)
        })
        .collect::<Result<Vec<_>, _>>()?;

    // For the 2-image MVP use images 0 and 1.
    let img_a = &pano_images[0];
    let img_b = &pano_images[1];

    if img_a.width != img_b.width || img_a.height != img_b.height {
        return Err(format!(
            "input images must be the same size for the MVP: {}×{} vs {}×{}",
            img_a.width, img_a.height, img_b.width, img_b.height
        ));
    }

    let image_size = (img_a.width, img_b.height);

    // --- 2. Detect features ------------------------------------------------
    eprintln!("pano-smoke: detecting features");
    let detector = OrbDetector::default();
    let feats_a = detector
        .detect(img_a)
        .map_err(|e| format!("detect on image A failed: {e}"))?;
    let feats_b = detector
        .detect(img_b)
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
    let pano_refs: Vec<&PanoImage> = pano_images.iter().collect();
    let (canvas_w, canvas_h) = compute_canvas_size(&pano_refs);

    let warped_a = warp_to_canvas(&warper, img_a, &cameras[0], canvas_w, canvas_h)?;
    let warped_b = warp_to_canvas(&warper, img_b, &cameras[1], canvas_w, canvas_h)?;

    // Count valid pixels for diagnostic output.
    let valid_a = warped_a.validity.count_ones();
    let valid_b = warped_b.validity.count_ones();
    eprintln!("pano-smoke:   warped A valid_px={valid_a}  warped B valid_px={valid_b}");

    // --- 7. Seam finding ---------------------------------------------------
    eprintln!("pano-smoke: finding seams");
    let seam_finder = GraphCutSeamFinder::new();
    let seams = seam_finder
        .seams(&[&warped_a, &warped_b])
        .map_err(|e| format!("seam finding failed: {e}"))?;

    // --- 8. Blend ----------------------------------------------------------
    eprintln!("pano-smoke: blending");
    let blender = pano_core::MultiBandBlender::default();
    let result = blender
        .blend(&[&warped_a, &warped_b], &seams)
        .map_err(|e| format!("blending failed: {e}"))?;

    eprintln!("pano-smoke:   output {}×{}", result.width, result.height);

    // --- 9. Write PNG16 ----------------------------------------------------
    eprintln!("pano-smoke: writing {}", output.display());
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create output dir {}: {e}", parent.display()))?;
        }
    }
    write_pano_image_as_png16(&result, output)?;

    eprintln!("pano-smoke: done.");
    Ok(())
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
        stitch(&cli.inputs, &output, cli.max_dim)
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

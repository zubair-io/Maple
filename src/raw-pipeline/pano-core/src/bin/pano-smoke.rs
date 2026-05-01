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
    matching::{
        build_overlap_graph_from_rotations, gimbal_filter, gms_filter,
        predicted_homography_with_principal_points, BruteForceMatcher, OverlapGraphOptions,
        PairCandidateReason,
    },
    types::{Camera, Features, Matches, PanoImage},
    Blender, ColorSpace, CpuWarper, FeatureDetector, FeatureMatcher, GraphCutMaxFlowSeamFinder,
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

    /// Crop N pixels off each side of the final canvas before writing
    /// the PNG. Useful for trimming Laplacian-pyramid ringing at
    /// canvas-edge validity boundaries. Default 0 (no crop).
    #[arg(long, default_value_t = 0, value_name = "PIXELS")]
    crop_margin: u32,

    /// Blend algorithm: `simple-alpha` (default — feathered alpha,
    /// no Laplacian pyramid, never produces magenta-ringing
    /// artefacts) or `multi-band` (Laplacian pyramid, hides low-
    /// frequency exposure mismatches but rings at validity edges).
    #[arg(long, default_value = "simple-alpha", value_name = "MODE")]
    blend_mode: String,

    /// Partition mode:
    /// - `distance-field` (default) — fast hard partition by argmax
    ///   of per-image distance-from-validity-edge. Eliminates
    ///   blend-averaging ghosts. Seams pass through validity-edge
    ///   midpoints. O(N · canvas), no max-flow.
    /// - `graphcut` — graph-cut min-cost seams via BK max-flow,
    ///   routes seams through smooth regions. Optimal but slow.
    /// - `voronoi` — legacy soft inverse-square + feather weights.
    ///   Averages overlap content → ghosting when BA residual
    ///   produces misalignment.
    #[arg(long, default_value = "distance-field", value_name = "MODE")]
    partition: String,

    /// Feather radius (px) at graph-cut seam boundaries to soften
    /// hard transitions between adjacent images. 0 = no feather
    /// (sharp seams), 4-8 = invisible-but-narrow blend (default 4).
    #[arg(long, default_value_t = 4, value_name = "PIXELS")]
    seam_feather: u32,

    /// Downsample factor for graph-cut seam finding. The BK max-flow
    /// runs on a `1/factor`-resolution copy of the canvas, then the
    /// chosen labels are upsampled. Reduces wall time from
    /// "minutes per pair" (factor=1) to "seconds per pair" (factor=8)
    /// for ~50 MP canvases. Seam routes are coarse to ±factor/2 px,
    /// which is invisible after the seam feather. Default 8.
    #[arg(long, default_value_t = 8, value_name = "FACTOR")]
    seam_downsample: u32,

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
/// Pre-matrix Rec.2020 desaturation: when a Rec.2020 pixel has
/// extreme channel imbalance — i.e. the spread `max(r, g, b) −
/// min(r, g, b)` exceeds a threshold AND the minimum channel is near
/// 0 — soft-blend it toward its Rec.2020-luminance projection
/// proportionally to how far past the threshold it is.
///
/// These extreme-imbalance pixels can't occur in real captured
/// content (lens + sensor smooths them out) — they're produced by
/// pipeline-internal effects (GainMap amplification at corners,
/// lens-distortion bilinear at extreme positions, DCP matrix mixing)
/// and are exactly what produce the magenta/cyan/yellow bands we
/// see at validity edges. Treating them as artefacts and
/// pre-emptively desaturating prevents downstream gamut clipping
/// from showing them as pure-primary bands.
///
/// The threshold of 0.85 is conservative — only triggers on truly
/// extreme imbalance like (1.0, 0.05, 1.0). Natural content ramps
/// don't hit it.
#[inline]
fn soft_desaturate_rec2020(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max_c = r.max(g).max(b);
    let min_c = r.min(g).min(b);
    let spread = max_c - min_c;
    // Detection: pixels where the spread between brightest and dimmest
    // channels exceeds 0.35 in Rec.2020 linear space. Natural scene
    // content has spread ≲ 0.3 even for saturated highlights;
    // pipeline-artefact pixels (GainMap × DCP × distortion at
    // extreme corners + bilinear edge effects) routinely exceed
    // the threshold and are responsible for residual magenta bands
    // at validity edges. Treating them as artefacts and
    // desaturating prevents downstream matrix conversion + clip
    // from rendering them as pure-primary stripes.
    //
    // 0.35 is conservative — it catches the magenta-producing
    // band-edge artefacts while preserving real saturated content
    // (sun reflections, vivid foliage). On pano_01 it cuts the
    // residual pure-magenta count from ~6 K to ~30 with no
    // visible loss of saturation in the rendered image.
    const SPREAD_THRESHOLD: f32 = 0.35;
    const FULL_DESAT_SPREAD: f32 = 0.6;
    if spread <= SPREAD_THRESHOLD {
        return (r, g, b);
    }
    // Rec.2020 luminance coefficients (BT.2020 non-constant Y').
    let y = 0.2627 * r + 0.6780 * g + 0.0593 * b;
    // Linearly ramp the desaturation factor from 0 at the threshold
    // to 1 at FULL_DESAT_SPREAD. A pixel with spread = 0.65 (halfway
    // through the ramp) gets 50% blended toward luminance.
    let t = ((spread - SPREAD_THRESHOLD) / (FULL_DESAT_SPREAD - SPREAD_THRESHOLD)).clamp(0.0, 1.0);
    (r + t * (y - r), g + t * (y - g), b + t * (y - b))
}

/// Soft sRGB gamut mapping: when a pixel exceeds [0, 1] on any
/// channel, desaturate (blend toward luminance) just enough to bring
/// all channels into range. This is the right behaviour vs.
/// per-channel `clamp(0, 1)`, which clips Rec.2020-saturated colours
/// to gamut-edge primaries and produces the pure-magenta /
/// cyan / yellow signatures we'd otherwise see at every pixel where
/// the GainMap, lens-distortion correction, or Rec.2020 → sRGB
/// matrix conversion happens to push a channel out of range.
///
/// Algorithm: blend the input `(r, g, b)` toward `(Y, Y, Y)` (the
/// Rec.709 luminance projection) by a factor `t ∈ [0, 1]` chosen so
/// that the blended result has every channel in `[0, 1]`. We use the
/// minimal `t` needed, so in-gamut pixels are unchanged and
/// out-of-gamut pixels are desaturated as little as possible.
#[inline]
fn gamut_clamp_srgb(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    if r >= 0.0 && g >= 0.0 && b >= 0.0 && r <= 1.0 && g <= 1.0 && b <= 1.0 {
        return (r, g, b);
    }
    // Rec.709 luminance, clamped to in-gamut range.
    let y = (0.2126 * r + 0.7152 * g + 0.0722 * b).clamp(0.0, 1.0);
    // Find the smallest `t ∈ [0, 1]` such that for every channel `c`:
    //   c' = c + t · (y − c)  is in [0, 1].
    //
    // For `c < 0` we need `c + t · (y − c) ≥ 0`. If `y > c` then
    //   t ≥ −c / (y − c). Otherwise no `t ∈ [0, 1]` can fix it (the
    //   pixel is so far out-of-gamut even luminance can't help) — in
    //   that pathological case `t = 1` brings the pixel to exactly
    //   `(y, y, y)` which is in-gamut.
    //
    // For `c > 1` symmetrically: t ≥ (c − 1) / (c − y).
    let mut t: f32 = 0.0;
    for c in [r, g, b] {
        if c < 0.0 {
            let denom = y - c;
            if denom > 1e-9 {
                t = t.max(-c / denom);
            } else {
                t = 1.0;
            }
        } else if c > 1.0 {
            let denom = c - y;
            if denom > 1e-9 {
                t = t.max((c - 1.0) / denom);
            } else {
                t = 1.0;
            }
        }
    }
    let t = t.clamp(0.0, 1.0);
    (r + t * (y - r), g + t * (y - g), b + t * (y - b))
}

#[inline]
fn encoded_srgb_from_rec2020(r20: f32, g20: f32, b20: f32) -> (f32, f32, f32) {
    let (r20, g20, b20) = soft_desaturate_rec2020(r20, g20, b20);
    let (r_lin, g_lin, b_lin) = rec2020_linear_to_srgb_linear(r20, g20, b20);
    let (r_lin, g_lin, b_lin) = gamut_clamp_srgb(r_lin, g_lin, b_lin);
    (srgb_encode(r_lin), srgb_encode(g_lin), srgb_encode(b_lin))
}

fn write_pano_image_as_png16(img: &PanoImage, path: &Path) -> Result<(), String> {
    let n_pixels = (img.width as usize) * (img.height as usize);
    let mut buf = vec![0u8; n_pixels * 3 * 2]; // 16-bit big-endian, 3 channels

    for i in 0..n_pixels {
        let base_src = i * 3;
        // Pre-matrix Rec.2020 clamp: a Rec.2020 pixel like
        // (0.95, 0.05, 0.95) — in-gamut for Rec.2020 but extremely
        // imbalanced — converts to sRGB ≈ (1.48, −0.07, 1.04), which
        // even after `gamut_clamp_srgb` desaturation lands at a
        // visibly-pink (1.0, 0.11, 0.75). To avoid that, also
        // soft-clamp the Rec.2020 input itself: when channels span
        // an extreme range (max − min > 0.85), desaturate toward
        // Rec.2020 luminance enough to bring the pixel into a
        // less-pathological corner of Rec.2020 first.
        let (r_enc, g_enc, b_enc) = encoded_srgb_from_rec2020(
            img.pixels[base_src],
            img.pixels[base_src + 1],
            img.pixels[base_src + 2],
        );
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
        yaw.cos(),
        0.0,
        yaw.sin(),
        0.0,
        1.0,
        0.0,
        -yaw.sin(),
        0.0,
        yaw.cos(),
    );
    // Rx (pitch about X axis — tilt)
    let rx = nalgebra::Matrix3::new(
        1.0,
        0.0,
        0.0,
        0.0,
        pitch.cos(),
        -pitch.sin(),
        0.0,
        pitch.sin(),
        pitch.cos(),
    );
    // Rz (roll about Z axis)
    let rz = nalgebra::Matrix3::new(
        roll.cos(),
        -roll.sin(),
        0.0,
        roll.sin(),
        roll.cos(),
        0.0,
        0.0,
        0.0,
        1.0,
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
        .map(|(i, r)| Some(CameraPrior::new(r.cast::<f64>(), initial_focals[i] as f32)))
        .collect();

    Ok(priors)
}

/// Choice of pixel blend after warping.
#[derive(Debug, Clone, Copy)]
enum BlendMode {
    /// Per-pixel feathered alpha. No pyramid → no Laplacian ringing.
    /// Output is a convex combination of inputs, so it can never
    /// exceed the input gamut → never produces magenta clipping
    /// artefacts at seams. Trade-off: low-frequency exposure
    /// mismatches show as soft gradients across overlap regions
    /// (where multi-band would hide them at coarse pyramid levels).
    SimpleAlpha,
    /// Multi-band Laplacian-pyramid blend. Hides low-frequency
    /// exposure differences but rings at validity edges.
    MultiBand,
}

/// Choice of canvas-pixel partition strategy. Determines the per-image
/// weight mask passed to the blender.
#[derive(Debug, Clone, Copy)]
enum PartitionMode {
    /// Soft inverse-square + feather weights. Smooth transitions
    /// across overlap regions; averages mis-aligned content → ghosts
    /// when BA residual + parallax produces pixel-level misalignment.
    Voronoi,
    /// Hard partition by argmax of per-image distance-from-validity-
    /// edge. Each pixel assigned to whichever image has the deepest
    /// "interior position" at that canvas spot. Eliminates averaging
    /// in overlap interiors → no ghosting. Fast (O(N · canvas), no
    /// max-flow). Seams pass through validity-edge midpoints, not
    /// optimised for content. Default.
    DistanceField,
    /// Graph-cut min-cost seams via BK max-flow. Routes seams through
    /// low-energy regions (sky, water) where the choice of source
    /// image is invisible. Optimal but slow at 50MP+ scale even with
    /// downsampling — use when you can spare minutes for the cut.
    GraphCut,
}

fn stitch(
    inputs: &[PathBuf],
    output: &Path,
    _max_dim: u32,
    projection: Projection,
    crop_margin: u32,
    blend_mode: BlendMode,
    partition_mode: PartitionMode,
    seam_feather: u32,
    seam_downsample: u32,
) -> Result<(), String> {
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
    let mut principal_points_per_image: Vec<Option<(f32, f32)>> = Vec::with_capacity(n);

    for p in inputs {
        eprintln!("pano-smoke:   {}", p.display());
        let bytes = fs::read(p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
        // Try to get gimbal + focal + lens distortion from raw_core for DNGs.
        let (gimbal, focal_px, dist, principal_point) =
            if pano_core::ingest::sniff_format(&bytes) == pano_core::ingest::PanoFormat::Raw {
                match raw_core::decode_for_pano(&bytes, "dng") {
                    Ok(ingest) => (
                        ingest.gimbal.map(|g| (g.yaw_deg, g.pitch_deg, g.roll_deg)),
                        ingest.focal_pixels,
                        ingest.distortion,
                        ingest.principal_point,
                    ),
                    Err(_) => (None, None, None, None),
                }
            } else {
                (None, None, None, None)
            };
        gimbal_priors.push(gimbal);
        focal_pixels_per_image.push(focal_px);
        distortion_per_image.push(dist);
        principal_points_per_image.push(principal_point);

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
    let mut all_features: Vec<Features> = pano_images
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

    // --- 2b. Undistort detected keypoints ---------------------------------
    //
    // Detected keypoints sit on the distorted (raw sensor) image. If we
    // hand those to bundle adjustment as-is, BA assumes pinhole projection
    // and tries to explain the residual radial compression by adjusting
    // focal — which is exactly what we observed in Steps 4-5 (cam[3,4]
    // focals drifting to 3747-3821 px from the EXIF prior of 3584).
    //
    // Pre-undistorting once here puts every keypoint into ideal-pinhole
    // coordinates. Match indices stay valid (we modify positions in place,
    // not the index arrays). Descriptors stay valid because AKAZE
    // descriptors are computed from local image patches centred on the
    // (distorted) keypoint position; we don't re-extract.
    //
    // Only runs for cameras where we have BOTH a per-image focal and
    // distortion coefficients (always true for DJI DNGs after Steps 1+5,
    // never true for synthetic / non-DNG inputs which have no distortion).
    let mut undistorted_count = 0usize;
    for (i, feats) in all_features.iter_mut().enumerate() {
        if let (Some(focal), Some((k1, k2))) = (focal_pixels_per_image[i], distortion_per_image[i])
        {
            if k1 == 0.0 && k2 == 0.0 {
                continue;
            }
            let (cx, cy) = principal_points_per_image[i].unwrap_or((
                pano_images[i].width as f32 * 0.5,
                pano_images[i].height as f32 * 0.5,
            ));
            for kp in feats.keypoints.iter_mut() {
                let (px, py) =
                    pano_core::warp::distortion::undistort_pixel(kp.x, kp.y, cx, cy, focal, k1, k2);
                kp.x = px;
                kp.y = py;
            }
            undistorted_count += 1;
        }
    }
    if undistorted_count > 0 {
        eprintln!(
            "pano-smoke: undistorted keypoints in {undistorted_count}/{n} images \
             (Brown-Conrady inverse, 8 fixed-point iters)"
        );
    }

    let has_all_gimbal = gimbal_priors.iter().all(|g| g.is_some());

    let use_overlap_graph = std::env::var("PANO_USE_OVERLAP_GRAPH").is_ok();
    let pair_candidates: Vec<(usize, usize, PairCandidateReason)> = if has_all_gimbal && use_overlap_graph {
        let rotations: Vec<nalgebra::Matrix3<f64>> = gimbal_priors
            .iter()
            .map(|g| {
                let (y, p, r) = g.expect("has_all_gimbal checked above");
                gimbal_to_rotation(y, p, r).cast::<f64>()
            })
            .collect();
        let focals: Vec<f64> = focal_pixels_per_image
            .iter()
            .map(|f| f.unwrap_or(image_size.0.max(image_size.1) as f32) as f64)
            .collect();
        let image_sizes: Vec<(u32, u32)> = pano_images
            .iter()
            .map(|img| (img.width, img.height))
            .collect();
        let mut graph_options = OverlapGraphOptions::default();
        graph_options.enable_skip_neighbors = true;
        graph_options.min_estimated_overlap = 0.10;
        let graph =
            build_overlap_graph_from_rotations(&rotations, &focals, &image_sizes, &graph_options)
                .map_err(|e| format!("overlap graph failed: {e}"))?;
        eprintln!(
            "pano-smoke: overlap graph selected {} candidate pairs across {} rows (connected={}, components={})",
            graph.candidates.len(),
            graph.row_count,
            graph.is_connected,
            graph.component_count
        );
        if !graph.is_connected {
            eprintln!(
                "pano-smoke:   WARNING overlap graph disconnected; isolated={:?}",
                graph.isolated_pose_indices
            );
        }
        let candidates: Vec<(usize, usize, PairCandidateReason)> = graph
            .candidates
            .iter()
            .map(|c| (c.a, c.b, c.reason))
            .collect();
        if candidates.is_empty() {
            eprintln!("pano-smoke:   overlap graph empty — falling back to input-order pairs");
            (0..(n - 1))
                .map(|i| (i, i + 1, PairCandidateReason::Horizontal))
                .collect()
        } else {
            candidates
        }
    } else {
        if has_all_gimbal {
            eprintln!(
                "pano-smoke: overlap graph disabled by default; set PANO_USE_OVERLAP_GRAPH=1 to enable graph-expanded BA edges"
            );
        }
        (0..(n - 1))
            .map(|i| (i, i + 1, PairCandidateReason::Horizontal))
            .collect()
    };

    // --- 3. Match overlap pairs: loose BF → GMS → gimbal filter → RANSAC ----
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
        "pano-smoke: loose BF → GMS → (gimbal filter when available) → RANSAC over {} candidate pairs",
        pair_candidates.len()
    );
    let matcher = BruteForceMatcher::new(0.95, false);
    let mut pairs: Vec<(usize, usize, Matches)> = Vec::new();
    let mut min_pair_inliers: usize = usize::MAX;

    for &(i, j, candidate_reason) in &pair_candidates {
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
        //
        // Auto-tuned tolerance: scales with the predicted angular
        // motion between the two cameras. The gimbal precision is ~0.3°
        // RMS in flight, lens distortion contributes another ~5 px
        // residual at corners. So tolerance = max(50, 1.5 × focal × tan
        // (gimbal_uncertainty_rad)) gives:
        //   - small relative motion (cam[1]↔cam[2]): tighter ball
        //     (~50 px) so we don't pass through zero-displacement
        //     consensus that survived GMS
        //   - large relative motion (cam[0]↔cam[1]): looser ball
        //     (~150 px) so the genuine matches at the gimbal-predicted
        //     shift survive the filter
        let gimbal_filtered: Matches = if let (
            Some((y_i, p_i, r_i)),
            Some((y_j, p_j, r_j)),
            Some(f_i),
            Some(f_j),
        ) = (
            gimbal_priors[i],
            gimbal_priors[j],
            focal_pixels_per_image[i],
            focal_pixels_per_image[j],
        ) {
            let r_a = gimbal_to_rotation(y_i, p_i, r_i).cast::<f64>();
            let r_b = gimbal_to_rotation(y_j, p_j, r_j).cast::<f64>();
            let pp_i = principal_points_per_image[i].unwrap_or((
                pano_images[i].width as f32 * 0.5,
                pano_images[i].height as f32 * 0.5,
            ));
            let pp_j = principal_points_per_image[j].unwrap_or((
                pano_images[j].width as f32 * 0.5,
                pano_images[j].height as f32 * 0.5,
            ));
            let h_pred = predicted_homography_with_principal_points(
                &r_a,
                f_i as f64,
                (pp_i.0 as f64, pp_i.1 as f64),
                &r_b,
                f_j as f64,
                (pp_j.0 as f64, pp_j.1 as f64),
            );

            // Per-pair tolerance: gimbal hardware ≈ 0.3° RMS in
            // flight, lens distortion residual ≈ 5 px at corners,
            // 50 px floor covers both with margin. We add a small
            // angular term scaled by the relative rotation
            // magnitude to absorb chained-pair drift in multi-row
            // panos: tol = 50 + 0.05 · focal · tan(|ω|).
            //
            // The factor 0.05 (5 % of the predicted shift) is the
            // budget for "gimbal disagrees with reality across this
            // specific pair" — sufficient to recover small-rotation
            // pairs that the previous 100 px hardcode was rejecting,
            // without inflating large-rotation tolerances enough to
            // poison RANSAC.
            let r_rel = r_b.transpose() * r_a;
            let omega_rel = pano_core::ba::joint::rodrigues_log(&r_rel);
            let omega_mag = omega_rel.norm();
            let pair_tol_px = 50.0_f64 + 0.05 * (f_i as f64) * omega_mag.tan().max(0.0);

            let kept = gimbal_filter(
                &gms,
                &all_features[i],
                &all_features[j],
                &h_pred,
                pair_tol_px,
            );
            eprintln!(
                    "pano-smoke:   pair ({i},{j}): GMS {} → gimbal-filter {} (tol={pair_tol_px:.0} px, |ω_rel|={:.1}°)",
                    gms.inliers.len(),
                    kept.inliers.len(),
                    omega_mag.to_degrees(),
                );
            kept
        } else {
            gms.clone()
        };

        // When gimbal data is available, the gimbal filter's verdict is
        // authoritative: a tiny survivor count means the matches genuinely
        // don't agree with the gimbal-predicted homography (typical for
        // small-rotation pairs where the drone drifted between frames and
        // most "matches" are zero-displacement noise). Falling back to
        // the un-filtered population would feed BA exactly the bad
        // matches the filter just rejected.
        //
        // Skip the pair entirely in that case — BA's rotation soft prior
        // covers the missing pairwise constraint via the chain of other
        // pairs and the gimbal prior on each camera.
        let have_gimbal_data = gimbal_priors[i].is_some()
            && gimbal_priors[j].is_some()
            && focal_pixels_per_image[i].is_some()
            && focal_pixels_per_image[j].is_some();

        let ransac_input = if gimbal_filtered.inliers.len() >= 8 {
            &gimbal_filtered
        } else if have_gimbal_data {
            // Gimbal filter rejected ≥99% of matches — trust the filter.
            // Skip this pair; soft prior carries the constraint.
            eprintln!(
                "pano-smoke:   pair ({i},{j}) {:?}: gimbal filter kept only {} — \
                 SKIPPING pair (matches disagree with gimbal; BA prior carries pose)",
                candidate_reason,
                gimbal_filtered.inliers.len()
            );
            min_pair_inliers = min_pair_inliers.min(gimbal_filtered.inliers.len());
            continue;
        } else if gms.inliers.len() >= 8 {
            // No gimbal data at all — fall back to GMS-only.
            eprintln!(
                "pano-smoke:   pair ({i},{j}): no gimbal data; using GMS-only ({} matches)",
                gms.inliers.len()
            );
            &gms
        } else {
            // GMS too aggressive — last-ditch fallback to raw BF matches.
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
            if have_gimbal_data {
                eprintln!(
                    "pano-smoke:   pair ({i},{j}) {:?}: below RANSAC minimum with gimbal data — skipping",
                    candidate_reason
                );
                continue;
            }
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
                "pano-smoke:   pair ({i},{j}) {:?}: RANSAC inliers={}/{}",
                candidate_reason,
                inlier_idxs.len(),
                ransac_input.inliers.len()
            );
            Matches {
                inliers: inlier_idxs
                    .iter()
                    .map(|&k| ransac_input.inliers[k])
                    .collect(),
            }
        } else if have_gimbal_data {
            eprintln!(
                "pano-smoke:   pair ({i},{j}) {:?}: RANSAC failed — skipping gimbal candidate",
                candidate_reason
            );
            continue;
        } else {
            eprintln!("pano-smoke:   WARNING pair ({i},{j}): RANSAC failed — using GMS matches");
            ransac_input.clone()
        };
        let min_ransac_inliers = match candidate_reason {
            PairCandidateReason::Horizontal | PairCandidateReason::Vertical => 30,
            PairCandidateReason::Skip | PairCandidateReason::Loop => 80,
        };
        if have_gimbal_data && inlier_matches.inliers.len() < min_ransac_inliers {
            eprintln!(
                "pano-smoke:   pair ({i},{j}) {:?}: only {} RANSAC inliers (< {min_ransac_inliers}) — skipping weak BA edge",
                candidate_reason,
                inlier_matches.inliers.len()
            );
            min_pair_inliers = min_pair_inliers.min(inlier_matches.inliers.len());
            continue;
        }
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
    let compute_relative_gimbal =
        |gimbal_priors: &[Option<(f32, f32, f32)>], i: usize| -> Option<nalgebra::Matrix3<f32>> {
            let r0 = gimbal_priors[0]
                .as_ref()
                .map(|(y, p, r)| gimbal_to_rotation(*y, *p, *r))?;
            let (y, p, r) = gimbal_priors[i]?;
            let r_abs = gimbal_to_rotation(y, p, r);
            Some(r0.transpose() * r_abs)
        };

    let mut cameras: Vec<Camera> = if has_all_gimbal {
        eprintln!(
            "pano-smoke: BA-with-rotation-soft-prior (DJI input; \
             λ_rot=33000 anchor on gimbal, focal anchor at EXIF prior)"
        );

        // Build per-camera priors from gimbal angles + EXIF focal.
        let priors: Vec<Option<CameraPrior>> =
            (0..n)
                .map(|i| {
                    let r_rel = compute_relative_gimbal(&gimbal_priors, i)?;
                    let omega = rodrigues_log(&r_rel.cast::<f64>());
                    let deg = omega.norm().to_degrees();
                    let focal_i = focal_pixels_per_image[i].unwrap_or(focal_prior);
                    eprintln!(
                        "pano-smoke:   gimbal_prior[{i}] omega_deg={deg:.1}  focal={focal_i:.1}",
                    );
                    Some(
                        CameraPrior::new(r_rel.cast::<f64>(), focal_i)
                            .with_principal_point(principal_points_per_image[i]),
                    )
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
            // Focal: tight anchor on the EXIF prior. At λ_f=1e6 a 1% drift
            // contributes ~100 px-equivalent residual per camera, a 5% drift
            // ~2500. This is intentional: with sub-mm-precision physical
            // FocalLength + sensor lookup the prior is accurate to <1%, so
            // any sizeable BA-driven focal drift would be BA misinterpreting
            // unmodelled parallax as a focal error.
            lambda_focal: 1_000_000.0,
            // Translation: planar-at-unit-depth absorber for the parallax
            // that pure rotation can't fit (drone drift between frames,
            // gimbal lever-arm offset, near-field foreground). λ_t=1e7
            // is empirically tuned on pano_01:
            //
            //   λ_t = 1e8: too tight, translations capped at ≲0.7% of
            //              unit depth, residual cost 7.8e4.
            //   λ_t = 1e6: too loose, translations grow to 5% of unit
            //              depth and rotations drift 2-3° from gimbal
            //              priors (BA discovers a local minimum that
            //              re-attributes some rotation to translation).
            //              Residual cost drops to 4.0e4 but the cameras
            //              are no longer trustworthy.
            //   λ_t = 1e7: middle ground — translations up to ~1-2% of
            //              unit depth, rotations stay within 1° of
            //              gimbal, focals within 1-3% of EXIF prior.
            lambda_translation: 1.0e7,
        };

        let cams = match solve_joint_with_priors(
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
                eprintln!("pano-smoke: BA failed ({e}) — falling back to gimbal-direct");
                priors
                    .iter()
                    .map(|p| {
                        let prior = p.unwrap();
                        Camera {
                            focal: prior.focal,
                            principal_point: prior.principal_point,
                            rotation: prior.rotation.cast::<f32>(),
                            translation: prior.translation.cast::<f32>(),
                            distortion: pano_core::types::Distortion::default(),
                        }
                    })
                    .collect::<Vec<_>>()
            }
        };

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
            lambda_translation: 0.0,
        };
        solve_joint_with_priors(&all_features, &pairs, image_size, Some(&priors), &ba_config)
            .map_err(|e| format!("joint BA failed: {e}"))?
    };

    // Attach per-image lens metadata from DNG WarpRectilinear. BA consumes the
    // principal point through priors when available; applying it again here
    // also covers homography-prior and fallback paths.
    for (i, cam) in cameras.iter_mut().enumerate() {
        if let Some(pp) = principal_points_per_image[i] {
            cam.principal_point = Some(pp);
        }
        if let Some((k1, k2)) = distortion_per_image[i] {
            cam.distortion = pano_core::types::Distortion { k1, k2 };
            eprintln!("pano-smoke:   cam[{i}] distortion k1={k1:.4}  k2={k2:.4}");
        }
    }

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
    let canvas = pano_core::warp::compute_canvas(&img_refs, &cameras, projection)
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

    // --- Auto-trim canvas to validity-union bbox -----------------------
    //
    // `compute_canvas` projects a 5×5 grid per input through the
    // spherical/cylindrical projection to estimate the union footprint,
    // but the projection bulges between sample points so the canvas
    // can extend several pixels past where any image actually has
    // data. Pure-black columns at the canvas edges show up as both
    // wasted output area and (more importantly) as transitions
    // between valid content and zero that are visually ugly.
    //
    // Compute the bbox of "any image is valid here" and trim every
    // warped image to it. Saves a small amount of canvas area and
    // eliminates the all-black slack rows/columns at the edges.
    // (Auto-trim is done post-blend — see `auto_trim_to_content` below.
    // Pre-blend validity-based trimming doesn't work here because the
    // warp marks pixels valid based on bilinear-sample in-bounds, but
    // the resulting RGB can still be near-zero at extreme edges where
    // the input image's actual content fades out.)

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

    // Erode each image's validity by 96 px and extrapolate RGB into a
    // 32-px feather band. Reduces (but does not eliminate) Laplacian-
    // pyramid ringing and source-edge colour pollution at validity
    // boundaries. DJI DNG edges can carry magenta-highlight artefacts
    // after lens correction and gain-map amplification; keeping those
    // border pixels out of the merge is safer than trying to repair
    // them after they have been blended into the panorama.
    eprintln!(
        "pano-smoke: eroding validity by 96 px + extrapolating RGB into feather ({} images)",
        warped.len()
    );
    for img in warped.iter_mut() {
        erode_validity(img, 96);
        extrapolate_into_invalid(img, 32);
    }

    // Single-pass N-way blend (replaces the prior chained pairwise blend).
    // The chain blew its working set across N=21 frames on a 180 MP canvas:
    // each step rebuilt a full pyramid pair, peaking at ~17 GB. The streaming
    // accumulator in MultiBandBlender::blend_n processes one image at a time,
    // dropping each pyramid before the next is allocated, so peak memory is
    // ~2× canvas regardless of N.
    let weight_masks = match partition_mode {
        PartitionMode::Voronoi => {
            eprintln!(
                "pano-smoke: building Voronoi partition masks ({} images)",
                warped.len()
            );
            build_partition_masks(&warped)
        }
        PartitionMode::DistanceField => {
            let t = std::time::Instant::now();
            let labels = pano_core::seam::compute_distance_field_labels(&warped);
            let n = warped.len();
            let n_pixels =
                (warped[0].width as usize) * (warped[0].height as usize);
            let mut masks: Vec<Vec<f32>> =
                (0..n).map(|_| vec![0.0_f32; n_pixels]).collect();
            for px in 0..n_pixels {
                if labels[px] >= 0 {
                    let i = labels[px] as usize;
                    if i < n {
                        masks[i][px] = 1.0;
                    }
                }
            }
            if seam_feather > 0 {
                let w = warped[0].width;
                let h = warped[0].height;
                pano_core::seam::feather_binary_masks(&mut masks, w, h, seam_feather);
            }
            eprintln!(
                "pano-smoke: distance-field partition ({} images, seam feather {} px) took {:?}",
                warped.len(),
                seam_feather,
                t.elapsed(),
            );
            masks
        }
        PartitionMode::GraphCut => {
            eprintln!(
                "pano-smoke: building graph-cut N-way partition ({} images, seam feather {} px, downsample {}×)",
                warped.len(),
                seam_feather,
                seam_downsample,
            );
            let mut masks =
                pano_core::seam::build_n_way_binary_masks(&warped, seam_downsample);
            if seam_feather > 0 {
                let w = warped[0].width;
                let h = warped[0].height;
                pano_core::seam::feather_binary_masks(&mut masks, w, h, seam_feather);
            }
            masks
        }
    };

    let warped_refs: Vec<&PanoImage> = warped.iter().collect();
    let result = match blend_mode {
        BlendMode::SimpleAlpha => {
            eprintln!("pano-smoke: simple-alpha blend (no pyramid, gamut-safe)");
            let blender = pano_core::SimpleAlphaBlender::new();
            blender
                .blend_n(&warped_refs, &weight_masks)
                .map_err(|e| format!("blend_n failed: {e}"))?
        }
        BlendMode::MultiBand => {
            eprintln!("pano-smoke: multi-band Laplacian blend");
            let blender = pano_core::MultiBandBlender::default();
            blender
                .blend_n(&warped_refs, &weight_masks)
                .map_err(|e| format!("blend_n failed: {e}"))?
        }
    };

    // Post-blend repair: detect clipping-artefact pixels (the
    // characteristic out-of-gamut signature of Laplacian-pyramid
    // ringing at validity edges) and replace them with the median
    // of nearby clean neighbours. The stricter pass handles hard
    // clipping; the display-encoded pass below handles moderate
    // magenta false colour that was already present in warped RAW
    // highlights or source-image borders.
    let mut repaired = result;
    let mut total_repaired = 0usize;
    let mut prev_count = usize::MAX;
    for _pass in 0..16 {
        let n = repair_magenta_clipping(&mut repaired);
        total_repaired += n;
        if n == 0 || n == prev_count {
            break;
        }
        prev_count = n;
    }
    if total_repaired > 0 {
        eprintln!("pano-smoke: repaired {total_repaired} clipping-artefact pixels (RGB ≈ 1,0,1)");
    }
    let display_magenta_repaired = suppress_display_magenta_false_color(&mut repaired);
    if display_magenta_repaired > 0 {
        eprintln!(
            "pano-smoke: suppressed {display_magenta_repaired} display-magenta false-colour pixels"
        );
    }

    // Auto-trim the canvas to the bounding box of non-near-zero
    // content. compute_canvas's 5×5 grid sampling slightly
    // overestimates the canvas extent (the spherical projection
    // bulges between sample points), leaving black slack rows/cols
    // at the canvas edges where no image actually has content. Trim
    // those out so the output isn't padded with empty pixels.
    let trimmed = if let Some(bbox) = compute_content_bbox(&repaired, 0.005) {
        let canvas_w = repaired.width;
        let canvas_h = repaired.height;
        if bbox.x_min > 0
            || bbox.y_min > 0
            || bbox.x_max + 1 < canvas_w
            || bbox.y_max + 1 < canvas_h
        {
            let new_w = bbox.x_max - bbox.x_min + 1;
            let new_h = bbox.y_max - bbox.y_min + 1;
            eprintln!(
                "pano-smoke: auto-trimming canvas {}×{} → {}×{} (cropped {} px L, {} px R, {} px T, {} px B)",
                canvas_w,
                canvas_h,
                new_w,
                new_h,
                bbox.x_min,
                canvas_w - bbox.x_max - 1,
                bbox.y_min,
                canvas_h - bbox.y_max - 1,
            );
            trim_to_bbox(&repaired, &bbox)
        } else {
            repaired
        }
    } else {
        repaired
    };

    let final_image = if crop_margin > 0 {
        eprintln!("pano-smoke: cropping {crop_margin} px off each side of canvas");
        crop_canvas(&trimmed, crop_margin)
    } else {
        trimmed
    };

    write_stitch(&final_image, output)?;
    eprintln!("pano-smoke: done.");
    Ok(())
}

/// Find the inclusive bounding box of pixels whose RGB max-channel
/// exceeds `threshold` — i.e. the actual content region of the
/// blended canvas. Used to auto-trim the slack rows/cols at the
/// canvas edges where compute_canvas's 5×5 grid sampling
/// overestimated the extent.
fn compute_content_bbox(img: &PanoImage, threshold: f32) -> Option<ValidityBbox> {
    let w = img.width;
    let h = img.height;
    let mut x_min = w;
    let mut y_min = h;
    let mut x_max: i64 = -1;
    let mut y_max: i64 = -1;
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let r = img.pixels[i * 3];
            let g = img.pixels[i * 3 + 1];
            let b = img.pixels[i * 3 + 2];
            if r > threshold || g > threshold || b > threshold {
                if x < x_min {
                    x_min = x;
                }
                if y < y_min {
                    y_min = y;
                }
                if (x as i64) > x_max {
                    x_max = x as i64;
                }
                if (y as i64) > y_max {
                    y_max = y as i64;
                }
            }
        }
    }
    if x_max < 0 || y_max < 0 {
        return None;
    }
    Some(ValidityBbox {
        x_min,
        y_min,
        x_max: x_max as u32,
        y_max: y_max as u32,
    })
}

/// Detect pixels with the pure-magenta clipping signature (R near 1,
/// G near 0, B near 1 — the natural output of Laplacian-pyramid
/// ringing where R/B saturate above gamut and G is driven below 0)
/// and replace each with the median of its non-magenta neighbours.
///
/// This is a post-blend repair pass. It exists because the multi-
/// band Laplacian blender introduces these artefacts at every image-
/// to-image seam transition, and the erode + extrapolate pre-process
/// only partially suppresses them.
///
/// Returns the number of pixels repaired.
fn repair_magenta_clipping(img: &mut PanoImage) -> usize {
    use rayon::prelude::*;

    let w = img.width as usize;
    let h = img.height as usize;
    let n = w * h;

    // Detection: Laplacian-pyramid ringing produces out-of-gamut
    // values where one channel overshoots above the natural max and
    // another undershoots below 0. The classic "magenta" signature is
    // R+B saturated above 1, G driven below 0; on the panorama
    // pipeline we also see other channel-imbalance signatures
    // (cyan, yellow) at validity edges. Detect any pixel that is:
    //   - any channel ≤ 0 (negative-clipped) AND
    //   - any other channel ≥ 0.95 (saturated)
    // This covers pure magenta (R=B=1, G=0), pure cyan (G=B=1, R=0),
    // pure yellow (R=G=1, B=0), and the partial-clipping equivalents
    // that the Rec.2020 → sRGB conversion later turns into pure-
    // primary clipping on disk.
    // Detection covers in-Rec.2020 values that *will* clip to a
    // primary edge after the Rec.2020 → sRGB matrix runs at encode
    // time. The matrix has off-diagonal terms ≈ ±0.1, so a Rec.2020
    // value like (1.0, 0.12, 1.0) — within natural-content gamut —
    // converts to sRGB ≈ (1, 0, 1) → pure magenta on disk. The
    // "any_low" threshold of 0.15 catches that case.
    let is_clipping_artefact = |idx: usize| -> bool {
        let r = img.pixels[idx * 3];
        let g = img.pixels[idx * 3 + 1];
        let b = img.pixels[idx * 3 + 2];
        let any_low = r < 0.15 || g < 0.15 || b < 0.15;
        let any_saturated = r > 0.95 || g > 0.95 || b > 0.95;
        let extreme_channel_imbalance =
            (r - g).abs() > 0.7 || (g - b).abs() > 0.7 || (r - b).abs() > 0.7;
        any_low && any_saturated && extreme_channel_imbalance
    };

    // Collect indices of clipping-artefact pixels first (parallel scan).
    let magenta_indices: Vec<usize> = (0..n)
        .into_par_iter()
        .filter(|&idx| is_clipping_artefact(idx))
        .collect();
    let count = magenta_indices.len();
    if count == 0 {
        return 0;
    }
    let _ = count;

    // For each magenta pixel, gather valid (non-magenta-leaning)
    // neighbours in a wide window (radius 12 = 25×25 = up to 624
    // neighbours) and compute a per-channel median replacement. Wide
    // window covers the band thickness so even centre-of-band pixels
    // can find good neighbours. Returns the actual count of changed
    // pixels (not just detected) so the iteration logic in the
    // caller can converge correctly.
    //
    // Neighbour rejection is broader than the detection threshold —
    // we exclude any neighbour where R+B is high relative to G
    // (loose-magenta), to avoid the median itself landing back in
    // the magenta range.
    let radius = 12i32;
    let replacements: Vec<(usize, [f32; 3])> = magenta_indices
        .par_iter()
        .map(|&idx| {
            let y = idx / w;
            let x = idx % w;
            let mut rs: Vec<f32> =
                Vec::with_capacity(((2 * radius + 1) * (2 * radius + 1)) as usize);
            let mut gs: Vec<f32> =
                Vec::with_capacity(((2 * radius + 1) * (2 * radius + 1)) as usize);
            let mut bs: Vec<f32> =
                Vec::with_capacity(((2 * radius + 1) * (2 * radius + 1)) as usize);
            for dy in -radius..=radius {
                for dx in -radius..=radius {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    let nidx = (ny as usize) * w + nx as usize;
                    let nr = img.pixels[nidx * 3];
                    let ng = img.pixels[nidx * 3 + 1];
                    let nb = img.pixels[nidx * 3 + 2];
                    // Skip neighbours that are themselves clipping
                    // artefacts (same predicate as `is_clipping_artefact`).
                    let any_low = nr < 0.15 || ng < 0.15 || nb < 0.15;
                    let any_sat = nr > 0.95 || ng > 0.95 || nb > 0.95;
                    let imbalance =
                        (nr - ng).abs() > 0.7 || (ng - nb).abs() > 0.7 || (nr - nb).abs() > 0.7;
                    if any_low && any_sat && imbalance {
                        continue;
                    }
                    // Skip canvas-invalid black.
                    if nr < 1e-3 && ng < 1e-3 && nb < 1e-3 {
                        continue;
                    }
                    rs.push(nr);
                    gs.push(ng);
                    bs.push(nb);
                }
            }
            if rs.len() < 4 {
                return (
                    idx,
                    [
                        img.pixels[idx * 3],
                        img.pixels[idx * 3 + 1],
                        img.pixels[idx * 3 + 2],
                    ],
                );
            }
            rs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            gs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            bs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let mid = rs.len() / 2;
            (idx, [rs[mid], gs[mid], bs[mid]])
        })
        .collect();

    // Apply replacements and count actual changes.
    let mut actually_changed = 0usize;
    for (idx, rgb) in replacements {
        let was_changed = (img.pixels[idx * 3] - rgb[0]).abs() > 1e-6
            || (img.pixels[idx * 3 + 1] - rgb[1]).abs() > 1e-6
            || (img.pixels[idx * 3 + 2] - rgb[2]).abs() > 1e-6;
        if was_changed {
            img.pixels[idx * 3] = rgb[0];
            img.pixels[idx * 3 + 1] = rgb[1];
            img.pixels[idx * 3 + 2] = rgb[2];
            actually_changed += 1;
        }
    }
    actually_changed
}

/// Suppress moderate magenta false colour that survives the hard-clipping
/// repair. This catches pixels that are not numerically extreme in Rec.2020
/// but still encode to visible pink after the final sRGB conversion, which is
/// the signature seen on pano_01's clipped clouds and warped source borders.
fn suppress_display_magenta_false_color(img: &mut PanoImage) -> usize {
    use rayon::prelude::*;

    img.pixels
        .par_chunks_exact_mut(3)
        .map(|px| {
            let (r_enc, g_enc, b_enc) = encoded_srgb_from_rec2020(px[0], px[1], px[2]);
            let magenta_excess = (r_enc - g_enc).min(b_enc - g_enc);
            let visible_magenta = r_enc > 0.08
                && b_enc > 0.08
                && magenta_excess > 0.025
                && r_enc > g_enc
                && b_enc > g_enc;

            if !visible_magenta {
                return 0usize;
            }

            let y = 0.2627 * px[0] + 0.6780 * px[1] + 0.0593 * px[2];
            let strength = ((magenta_excess - 0.025) / 0.12).clamp(0.55, 1.0);
            px[0] += (y - px[0]) * strength;
            px[1] += (y - px[1]) * strength;
            px[2] += (y - px[2]) * strength;
            1usize
        })
        .sum()
}

/// Inclusive bounding box of canvas pixels where at least one image
/// has valid coverage, used to auto-trim the canvas after warping.
struct ValidityBbox {
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
}

/// Find the inclusive bounding box of pixels where at least one of
/// the supplied warped images has its validity bit set. Returns
/// `None` when no image has any valid pixels (degenerate, shouldn't
/// happen post-warp but guard anyway).
fn compute_validity_union_bbox(warped: &[PanoImage]) -> Option<ValidityBbox> {
    if warped.is_empty() {
        return None;
    }
    let w = warped[0].width;
    let h = warped[0].height;
    let mut x_min = w;
    let mut y_min = h;
    let mut x_max: i64 = -1;
    let mut y_max: i64 = -1;
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let any_valid = warped.iter().any(|img| img.validity[idx]);
            if any_valid {
                if x < x_min {
                    x_min = x;
                }
                if y < y_min {
                    y_min = y;
                }
                if (x as i64) > x_max {
                    x_max = x as i64;
                }
                if (y as i64) > y_max {
                    y_max = y as i64;
                }
            }
        }
    }
    if x_max < 0 || y_max < 0 {
        return None;
    }
    Some(ValidityBbox {
        x_min,
        y_min,
        x_max: x_max as u32,
        y_max: y_max as u32,
    })
}

/// Trim `img` to the inclusive bbox `bbox`, returning a new
/// `PanoImage` of dimensions `(bbox.x_max − bbox.x_min + 1,
/// bbox.y_max − bbox.y_min + 1)`. Both pixel data and validity
/// bitmap are copied.
fn trim_to_bbox(img: &PanoImage, bbox: &ValidityBbox) -> PanoImage {
    let new_w = bbox.x_max - bbox.x_min + 1;
    let new_h = bbox.y_max - bbox.y_min + 1;
    let mut out = PanoImage::new(new_w, new_h, img.color);
    let src_w = img.width;
    for y in 0..new_h {
        for x in 0..new_w {
            let src_x = x + bbox.x_min;
            let src_y = y + bbox.y_min;
            let src_idx = (src_y * src_w + src_x) as usize;
            let dst_idx = (y * new_w + x) as usize;
            out.pixels[dst_idx * 3] = img.pixels[src_idx * 3];
            out.pixels[dst_idx * 3 + 1] = img.pixels[src_idx * 3 + 1];
            out.pixels[dst_idx * 3 + 2] = img.pixels[src_idx * 3 + 2];
            out.validity.set(dst_idx, img.validity[src_idx]);
        }
    }
    out
}

/// Crop `margin` pixels off each side of `img`, returning a new
/// `PanoImage` of dimensions `(w − 2·margin, h − 2·margin)`.
///
/// Used to trim Laplacian-pyramid ringing artifacts at canvas-edge
/// validity boundaries. If the image is smaller than `2·margin` in
/// either dimension the input is returned unchanged.
fn crop_canvas(img: &PanoImage, margin: u32) -> PanoImage {
    let w = img.width;
    let h = img.height;
    if w <= 2 * margin || h <= 2 * margin {
        return img.clone();
    }
    let new_w = w - 2 * margin;
    let new_h = h - 2 * margin;
    let mut out = PanoImage::new(new_w, new_h, img.color);
    for y in 0..new_h {
        for x in 0..new_w {
            let src_x = x + margin;
            let src_y = y + margin;
            let src_idx = (src_y * w + src_x) as usize;
            let dst_idx = (y * new_w + x) as usize;
            out.pixels[dst_idx * 3] = img.pixels[src_idx * 3];
            out.pixels[dst_idx * 3 + 1] = img.pixels[src_idx * 3 + 1];
            out.pixels[dst_idx * 3 + 2] = img.pixels[src_idx * 3 + 2];
            out.validity.set(dst_idx, img.validity[src_idx]);
        }
    }
    out
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

    // ---------------------------------------------------------------------
    // Per-image edge-feather: distance from each valid pixel to the nearest
    // INVALID pixel of that image (capped at FEATHER_RADIUS). Used to
    // multiply the inverse-square partition weight so the mask smoothly
    // falls to zero at validity boundaries instead of stepping from
    // inverse-square-weight → 0 across a single pixel.
    //
    // Why: the multi-band Laplacian-pyramid blender oscillates at sharp
    // mask discontinuities. With pixel-wide steps, the high-frequency
    // bands push individual channels above 1.0 (clamped to 1.0) and below
    // 0.0 (clamped to 0.0), producing pure-magenta RGB(1,0,1) bands at
    // every footprint edge. Feathering the mask over FEATHER_RADIUS pixels
    // gives the pyramid a smooth transition that the coarsest band can
    // represent without ringing.
    //
    // FEATHER_RADIUS = 32 covers a 5-level pyramid (canvas/16 at the
    // coarsest band) with one pixel of margin.
    // ---------------------------------------------------------------------
    const FEATHER_RADIUS: f32 = 32.0;

    let edge_feathers: Vec<Vec<f32>> = warped
        .iter()
        .map(|img| compute_edge_feather(&img.validity, w, h, FEATHER_RADIUS))
        .collect();

    // For each pixel: if image i is valid there, weight_i ∝ feather_i / (1 + dist²)
    // where dist is the canvas-pixel distance to image i's center. Then
    // normalise so Σ_i weight_i = 1.0.
    let mut masks: Vec<Vec<f32>> = (0..n).map(|_| vec![0.0_f32; n_pixels]).collect();

    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            // First pass: feathered inverse-square weights for valid images.
            let mut total = 0.0_f32;
            for i in 0..n {
                if warped[i].validity[idx] {
                    let dx = x as f32 - centers[i].0;
                    let dy = y as f32 - centers[i].1;
                    let d2 = dx * dx + dy * dy;
                    let inv_sq = 1.0 / (1.0 + d2);
                    let feather = edge_feathers[i][idx];
                    let w_raw = inv_sq * feather;
                    masks[i][idx] = w_raw;
                    total += w_raw;
                }
            }
            // Normalise to sum to 1.0. If total is zero (all image
            // weights have been feathered to zero at this pixel — only
            // happens at the very edge of every image's footprint at
            // once), fall back to raw inverse-square so the pixel still
            // gets a contribution and isn't left as RGB(0,0,0).
            if total > 1e-12 {
                for i in 0..n {
                    masks[i][idx] /= total;
                }
            } else {
                let mut fallback_total = 0.0_f32;
                for i in 0..n {
                    if warped[i].validity[idx] {
                        let dx = x as f32 - centers[i].0;
                        let dy = y as f32 - centers[i].1;
                        let d2 = dx * dx + dy * dy;
                        let w_raw = 1.0 / (1.0 + d2);
                        masks[i][idx] = w_raw;
                        fallback_total += w_raw;
                    }
                }
                if fallback_total > 1e-12 {
                    for i in 0..n {
                        masks[i][idx] /= fallback_total;
                    }
                }
            }
        }
    }

    masks
}

/// Erode the validity bitmap by `radius` pixels — i.e. mark any
/// currently-valid pixel that is within `radius` of an invalid pixel
/// as invalid itself. This trims unreliable boundary content (lens
/// distortion + GainMap interactions, bilinear-from-out-of-bounds)
/// before pyramid blending so it doesn't pollute the result.
///
/// Implementation: chamfer-style two-pass distance transform from
/// invalid pixels, then any pixel with distance < radius gets marked
/// invalid.
///
/// RGB pixel values are NOT modified — only the validity bitmap.
fn erode_validity(image: &mut PanoImage, radius: u32) {
    let w = image.width;
    let h = image.height;
    let dist = compute_edge_feather(&image.validity, w, h, radius as f32);
    // compute_edge_feather returns normalised [0, 1] distance —
    // anything < 1.0 is within the eroded band.
    for (idx, d) in dist.iter().enumerate() {
        if *d < 1.0 {
            image.validity.set(idx, false);
        }
    }
}

/// Extrapolate each image's RGB values into a band of `iterations`
/// pixels around the validity boundary, by repeated nearest-valid-
/// neighbour averaging.
///
/// Validity is NOT modified — only the pixel data. This pre-processing
/// step prevents the multi-band Laplacian pyramid from seeing a hard
/// step (valid pixel value → 0) at every image's footprint edge, which
/// would otherwise produce pure-magenta RGB(1,0,1) ringing in the
/// reconstructed output (R/B saturate, G clamps to 0).
///
/// Implementation: each iteration scans the image once and, for any
/// pixel that is currently "unfilled" but has at least one filled
/// 8-connected neighbour, sets its RGB to the mean of those filled
/// neighbours. Iterations propagate filled values outward by one
/// pixel per pass, so `iterations` controls how far the extrapolation
/// reaches.
///
/// Parallelised across rows via rayon. Each iteration is O(W × H).
/// For a 7800 × 6300 canvas with 16 iterations this runs in ~3 s
/// on a typical multi-core machine.
fn extrapolate_into_invalid(image: &mut PanoImage, iterations: u32) {
    use rayon::prelude::*;

    let w = image.width as usize;
    let h = image.height as usize;
    let n = w * h;

    // Track which pixels have been "filled" (originally valid +
    // extrapolated). Start with the original validity bitmap.
    let mut filled: Vec<bool> = (0..n).map(|i| image.validity[i]).collect();

    for _ in 0..iterations {
        // Snapshot the previous-iteration state so all reads are
        // consistent (we don't read pixels we just wrote in this pass,
        // which would propagate values further than 1 px per iteration).
        let prev_pixels = image.pixels.clone();
        let prev_filled = filled.clone();

        // Build per-row updates in parallel, then apply.
        let row_updates: Vec<Vec<(usize, [f32; 3])>> = (0..h)
            .into_par_iter()
            .map(|y| {
                let mut updates: Vec<(usize, [f32; 3])> = Vec::new();
                for x in 0..w {
                    let idx = y * w + x;
                    if prev_filled[idx] {
                        continue;
                    }
                    let mut sum = [0.0f32; 3];
                    let mut count = 0u32;
                    for dy in -1i32..=1 {
                        for dx in -1i32..=1 {
                            if dx == 0 && dy == 0 {
                                continue;
                            }
                            let nx = x as i32 + dx;
                            let ny = y as i32 + dy;
                            if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                                continue;
                            }
                            let nidx = (ny as usize) * w + nx as usize;
                            if prev_filled[nidx] {
                                sum[0] += prev_pixels[nidx * 3];
                                sum[1] += prev_pixels[nidx * 3 + 1];
                                sum[2] += prev_pixels[nidx * 3 + 2];
                                count += 1;
                            }
                        }
                    }
                    if count > 0 {
                        let inv_n = 1.0 / count as f32;
                        updates.push((idx, [sum[0] * inv_n, sum[1] * inv_n, sum[2] * inv_n]));
                    }
                }
                updates
            })
            .collect();

        // Apply updates serially (writing to image.pixels and filled).
        for row in row_updates {
            for (idx, rgb) in row {
                image.pixels[idx * 3] = rgb[0];
                image.pixels[idx * 3 + 1] = rgb[1];
                image.pixels[idx * 3 + 2] = rgb[2];
                filled[idx] = true;
            }
        }
    }
    // Note: image.validity is unchanged. Extrapolated pixels remain
    // marked invalid so the partition-mask logic excludes them from
    // the weighted sum — only the Laplacian pyramid sees the smooth
    // values.
}

/// Compute, for each pixel of `validity`, the distance to the nearest
/// invalid pixel (or canvas border, treated as invalid), capped at
/// `feather_radius` and normalised to [0, 1].
///
/// Implementation: chamfer-distance two-pass sweep (forward + backward),
/// using horizontal/vertical step = 1 and diagonal step = √2. Accuracy
/// is within ~1 % of true Euclidean distance up to the cap, which is
/// well within the precision needed for mask feathering.
///
/// Returns a flat row-major vec the same shape as `validity`. Values
/// in [0.0, 1.0]: 0 at invalid pixels and within `feather_radius` of an
/// invalid edge, 1 deep inside the validity region.
fn compute_edge_feather(
    validity: &bitvec::vec::BitVec,
    w: u32,
    h: u32,
    feather_radius: f32,
) -> Vec<f32> {
    let n = (w as usize) * (h as usize);
    let cap = feather_radius;
    // Use a sentinel large value for "very far from boundary" — we'll
    // cap it below.
    let mut dist = vec![cap + 1.0; n];

    // Initialise: invalid pixels and canvas border pixels start at 0.
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let on_border = x == 0 || y == 0 || x == w - 1 || y == h - 1;
            if !validity[idx] || on_border {
                dist[idx] = 0.0;
            }
        }
    }

    // Forward pass: top-left → bottom-right. For each pixel, take the
    // minimum of neighbours to the N, NW, NE, W (each + chamfer step).
    let stride = w as usize;
    let diag = std::f32::consts::SQRT_2;
    for y in 0..h {
        for x in 0..w {
            let idx = (y as usize) * stride + (x as usize);
            if dist[idx] == 0.0 {
                continue;
            }
            let mut d = dist[idx];
            if x > 0 {
                d = d.min(dist[idx - 1] + 1.0);
            }
            if y > 0 {
                d = d.min(dist[idx - stride] + 1.0);
                if x > 0 {
                    d = d.min(dist[idx - stride - 1] + diag);
                }
                if (x as usize) < stride - 1 {
                    d = d.min(dist[idx - stride + 1] + diag);
                }
            }
            dist[idx] = d.min(cap);
        }
    }

    // Backward pass: bottom-right → top-left. Same chamfer steps,
    // opposite direction.
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let idx = (y as usize) * stride + (x as usize);
            if dist[idx] == 0.0 {
                continue;
            }
            let mut d = dist[idx];
            if (x as usize) < stride - 1 {
                d = d.min(dist[idx + 1] + 1.0);
            }
            if y < h - 1 {
                d = d.min(dist[idx + stride] + 1.0);
                if x > 0 {
                    d = d.min(dist[idx + stride - 1] + diag);
                }
                if (x as usize) < stride - 1 {
                    d = d.min(dist[idx + stride + 1] + diag);
                }
            }
            dist[idx] = d.min(cap);
        }
    }

    // Normalise to [0, 1].
    dist.iter_mut().for_each(|d| *d /= cap);
    dist
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
                principal_point: None,
                rotation: nalgebra::Matrix3::identity(),
                translation: nalgebra::Vector3::zeros(),
                distortion: pano_core::types::Distortion::default(),
            },
            Camera {
                focal: image_size.0.max(image_size.1) as f32,
                principal_point: None,
                rotation: nalgebra::Matrix3::identity(),
                translation: nalgebra::Vector3::zeros(),
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
        let blend_mode = match cli.blend_mode.to_ascii_lowercase().as_str() {
            "multi-band" | "multiband" | "multi_band" => BlendMode::MultiBand,
            _ => BlendMode::SimpleAlpha,
        };
        let partition_mode = match cli.partition.to_ascii_lowercase().as_str() {
            "voronoi" => PartitionMode::Voronoi,
            "graphcut" | "graph-cut" | "graph_cut" => PartitionMode::GraphCut,
            _ => PartitionMode::DistanceField,
        };
        stitch(
            &cli.inputs,
            &output,
            cli.max_dim,
            projection,
            cli.crop_margin,
            blend_mode,
            partition_mode,
            cli.seam_feather,
            cli.seam_downsample,
        )
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

    #[test]
    fn display_magenta_suppressor_neutralizes_false_color() {
        let mut img = PanoImage::new(1, 1, ColorSpace::rec2020_d65_linear());
        img.pixels[0] = 0.35;
        img.pixels[1] = 0.05;
        img.pixels[2] = 0.35;

        let changed = suppress_display_magenta_false_color(&mut img);
        assert_eq!(changed, 1);

        let (r, g, b) = encoded_srgb_from_rec2020(img.pixels[0], img.pixels[1], img.pixels[2]);
        assert!(
            (r - g).min(b - g) <= 0.025,
            "pixel still encodes magenta: ({r:.3}, {g:.3}, {b:.3})"
        );
    }

    #[test]
    fn display_magenta_suppressor_leaves_blue_sky_like_pixel() {
        let mut img = PanoImage::new(1, 1, ColorSpace::rec2020_d65_linear());
        img.pixels[0] = 0.08;
        img.pixels[1] = 0.18;
        img.pixels[2] = 0.35;
        let before = img.pixels.clone();

        let changed = suppress_display_magenta_false_color(&mut img);
        assert_eq!(changed, 0);
        assert_eq!(img.pixels, before);
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

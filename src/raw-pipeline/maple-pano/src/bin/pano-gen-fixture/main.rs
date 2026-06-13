//! `pano-gen-fixture` — deterministic synthetic pano fixture generator (#1256).
//!
//! Generates synthetic rotation-panorama frames as LinearRaw DNGs that
//! `decode_for_pano` can ingest and the strategy selector routes to
//! rotation-BA (not tile). Used to produce `test-fixtures/raws/pano_02/`.
//!
//! # pano_02 fixture parameters
//!
//! - 6 frames from a 180° partial ring (cameras 0–5, 30° yaw step)
//! - 60° horizontal FOV, 50% overlap between adjacent frames
//! - 1280×960 frames, 8192×4096 equirect source (seed 42)
//! - DNG PhotometricInterpretation=LinearRaw (34892), 3 samples per pixel,
//!   interleaved RGB — bypasses Bayer demosaic, preserves render fidelity
//! - EXIF FocalLength + FocalLengthIn35mmFormat so decode_for_pano derives
//!   focal_px and the strategy selector has a valid seed
//!
//! # Source texture
//!
//! The equirect source uses multi-octave hash value noise — NOT
//! `EquirectSource::synthetic()`. The synthetic scene has a 15° periodic
//! checkerboard that is adversarially periodic for ALIKED: descriptors of
//! distinct cell corners are near-identical and LightGlue locks frames onto
//! a cell-shifted alignment that MAGSAC++ then rejects (all frames become
//! Disconnected). Multi-octave noise avoids repeating structure at any scale
//! while remaining byte-deterministic for a given seed. See ml_smoke.rs for
//! the same rationale in the end-to-end matcher smoke test.
//!
//! Run:
//!   cargo run --release -p maple-pano --bin pano-gen-fixture \
//!       -- --out-dir test-fixtures/raws/pano_02
//!
//! Deterministic: same seed + same flags → byte-identical DNGs on the same
//! platform and toolchain version.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::source::EquirectSource;
use rayon::prelude::IndexedParallelIterator;
use rayon::prelude::IntoParallelRefMutIterator;
use rayon::prelude::ParallelIterator;

mod dng;
use dng::write_linearraw_dng;

// ─── Multi-octave hash noise equirect source ──────────────────────────────────
//
// Same algorithm as ml_glue.rs / ml_smoke.rs, parameterised with a seed.
// Three octaves at cell sizes 40 / 10 / 3 pixels give aperiodic spatial
// structure across a decade of scales. The fine 3-pixel cells produce the
// high-frequency gradients ALIKED needs: at 4096×2048 source resolution a
// 3-pixel cell spans ~0.26° — roughly 4–5 pixels in a 1024×768 frame at 60°
// FOV — which reliably generates 300+ keypoints above ALIKED's 0.2 threshold.
//
// EquirectSource::synthetic is NOT used here: its 15° periodic checker causes
// LightGlue to lock frames onto cell-shifted alignments that MAGSAC++ then
// rejects (all frames become Disconnected). See ml_smoke.rs for the same note.

fn hash(x: u64, y: u64, octave: u64) -> f32 {
    let mut h = x
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(y.wrapping_mul(0xC2B2_AE3D_27D4_EB4F))
        .wrapping_add(octave.wrapping_mul(0x1656_67B1_9E37_79F9));
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 33;
    (h & 0xFFFF) as f32 / 65535.0
}

/// Multi-octave value-noise equirect source. Byte-deterministic for a given
/// `seed`; `seed=0` reproduces the ml_glue / ml_smoke baseline.
///
/// Each RGB channel uses an independent seed offset so the noise has natural
/// colour variation (R ≠ G ≠ B). LightGlue was trained on colour images and
/// performs better when channels are not perfectly correlated.
fn noise_source(width: u32, height: u32, seed: u64) -> EquirectSource {
    let w = width as usize;
    let h = height as usize;
    // 3 channels × 3 octaves = 9 independent seed offsets.
    // Seeds are XOR'd with channel-specific and octave-specific constants
    // so each produces an independent noise field from the same hash kernel.
    let ch_seeds: [[u64; 3]; 3] = [
        // Red: octaves 0/1/2
        [
            seed,
            seed ^ 0xDEAD_BEEF_0000_0001,
            seed ^ 0xCAFE_BABE_0000_0002,
        ],
        // Green: shifted by a different prime-like constant
        [
            seed ^ 0x1234_5678_9ABC_DEF0,
            seed ^ 0xFEDC_BA98_7654_3210,
            seed ^ 0xA5A5_A5A5_0F0F_0F0F,
        ],
        // Blue
        [
            seed ^ 0x0F0F_0F0F_A5A5_A5A5,
            seed ^ 0x3C3C_3C3C_C3C3_C3C3,
            seed ^ 0x5555_AAAA_FFFF_0000,
        ],
    ];
    let mut pixels = vec![[0.0_f32; 3]; w * h];
    pixels.par_iter_mut().enumerate().for_each(|(idx, px)| {
        let iy = idx / w;
        let ix = idx % w;
        for (ch, oct_seeds) in ch_seeds.iter().enumerate() {
            let mut v = 0.0_f32;
            let mut amp = 0.5_f32;
            for (k, cell) in [40_usize, 10, 3].iter().enumerate() {
                let cell = *cell;
                let (gx, gy) = ((ix / cell) as u64, (iy / cell) as u64);
                let fx = (ix % cell) as f32 / cell as f32;
                let fy = (iy % cell) as f32 / cell as f32;
                let oct = oct_seeds[k];
                let top = hash(gx, gy, oct) * (1.0 - fx) + hash(gx + 1, gy, oct) * fx;
                let bot = hash(gx, gy + 1, oct) * (1.0 - fx) + hash(gx + 1, gy + 1, oct) * fx;
                v += amp * (top * (1.0 - fy) + bot * fy);
                amp *= 0.5;
            }
            px[ch] = v;
        }
    });
    EquirectSource {
        width,
        height,
        pixels,
    }
}

/// pano_02 fixture: 6-frame 180° partial rotation ring.
#[derive(Debug, Parser)]
#[command(name = "pano-gen-fixture", version, about)]
struct Args {
    /// Output directory (test-fixtures/raws/pano_02/).
    #[arg(long)]
    out_dir: PathBuf,

    /// Number of frames. Default: 6.
    #[arg(long, default_value_t = 6)]
    cameras: u32,

    /// Horizontal FOV per frame, degrees. Default: 60.0.
    #[arg(long, default_value_t = 60.0)]
    fov_deg: f64,

    /// Overlap between adjacent frames. Default: 0.5.
    #[arg(long, default_value_t = 0.5)]
    overlap: f64,

    /// Frame width in pixels. Default: 1280.
    #[arg(long, default_value_t = 1280)]
    width: u32,

    /// Frame height in pixels. Default: 960.
    #[arg(long, default_value_t = 960)]
    height: u32,

    /// Equirectangular source width. Height = width/2. Default: 8192.
    #[arg(long, default_value_t = 8192)]
    source_width: u32,

    /// Master seed for the synthetic source. Default: 42.
    #[arg(long, default_value_t = 42)]
    seed: u64,
}

fn main() -> ExitCode {
    let args = Args::parse();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("pano-gen-fixture: {}", e);
            ExitCode::FAILURE
        }
    }
}

fn run(args: &Args) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&args.out_dir)
        .map_err(|e| format!("{}: {}", args.out_dir.display(), e))?;

    let source_height = args.source_width / 2;
    let source = noise_source(args.source_width, source_height, args.seed);

    // Partial ring: cameras at 0°, step°, 2*step°, …
    // full:false means yaw step = fov*(1-overlap), not 360/count.
    let cam_opts = CameraSetOptions {
        count: args.cameras,
        pattern: Pattern::Ring { full: false },
        fov_deg: args.fov_deg,
        overlap: args.overlap,
        pitch_deg: 0.0,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: args.width,
        height: args.height,
    };
    // Camera seed independent of the scene seed (mirrors pano-gt-render).
    let mut cam_rng = SplitMix64::new(args.seed ^ 0xA076_1D64_78BD_642F);
    let gt_cams = build_camera_set(&cam_opts, &mut cam_rng)
        .map_err(|e| format!("build_camera_set: {}", e))?;

    // Focal length derivation (matches maple-pano ingest, priors.rs):
    //   f_px = focal_px_for_hfov(fov_deg, width)
    //   f35  = f_px * FULL_FRAME_DIAG_MM / image_diag_px
    // Round to integer (camera firmware convention).
    let full_frame_diag_mm: f64 = 43.266615305567875;
    let focal_px = maple_pano::camera::focal_px_for_hfov(args.fov_deg, args.width) as f64;
    let img_diag = ((args.width as f64).powi(2) + (args.height as f64).powi(2)).sqrt();
    let focal_35mm = (focal_px * full_frame_diag_mm / img_diag).round() as u16;
    // focal_mm: write same value as f35 simplified to 1:1 (full-frame convention).
    let focal_mm_num: u32 = focal_35mm as u32;
    let focal_mm_den: u32 = 1;

    eprintln!(
        "pano-gen-fixture: {} frames, FOV {:.1}°, overlap {:.0}%, {}x{} px, source {}x{}, seed {}",
        args.cameras,
        args.fov_deg,
        args.overlap * 100.0,
        args.width,
        args.height,
        args.source_width,
        source_height,
        args.seed
    );
    eprintln!(
        "pano-gen-fixture: focal_px = {:.1}, focal_35mm = {}, focal_mm = {}",
        focal_px, focal_35mm, focal_mm_num
    );

    for (i, gt_cam) in gt_cams.iter().enumerate() {
        let cam = gt_cam.to_camera();
        // Supersampling=2 (2x2 taps per pixel) for smoother synthetic renders.
        let frame = render_frame(&source, &cam, 2).map_err(|e| format!("frame {}: {}", i, e))?;

        // Write as LinearRaw DNG: interleaved RGB16, bypasses Bayer demosaic.
        let dng_path = args.out_dir.join(format!("frame_{:04}.dng", i));
        write_linearraw_dng(
            &dng_path,
            args.width,
            args.height,
            &frame,
            focal_mm_num,
            focal_mm_den,
            focal_35mm,
        )?;
        eprintln!(
            "  wrote {} ({} bytes)",
            dng_path.display(),
            std::fs::metadata(&dng_path).map(|m| m.len()).unwrap_or(0)
        );
    }

    eprintln!(
        "pano-gen-fixture: done — {} DNGs in {}",
        args.cameras,
        args.out_dir.display()
    );
    Ok(())
}

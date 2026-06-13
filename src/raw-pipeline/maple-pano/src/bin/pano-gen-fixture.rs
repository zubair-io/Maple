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

use std::io;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::source::EquirectSource;
use rayon::prelude::IndexedParallelIterator;
use rayon::prelude::IntoParallelRefMutIterator;
use rayon::prelude::ParallelIterator;

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

// ─── LinearRaw DNG writer ──────────────────────────────────────────────────────
//
// PhotometricInterpretation = LinearRaw (34892), SamplesPerPixel = 3,
// BitsPerSample = 16, interleaved [R0 G0 B0 R1 G1 B1 ...].
//
// Decode chain through decode_for_pano / pano/mod.rs:
//   1. linearraw_to_camera_rgb  → normalizes u16 by white_level (65535) → [0,1]
//   2. DNG DefaultCrop          → no-op (none written)
//   3. BaselineExposure         → no-op (0.0 written)
//   4. WB pre-gain (AsShotNeutral=[1,1,1]) → scale by 1/1 per channel → no-op
//   5. highlight recovery
//   6. DCP apply_colorimetry:
//      - ColorMatrix1 = identity is filtered by `is_approx_identity` in
//        profile_from_embedded → falls to step-4 rawler fallback which sets
//        CM = M_XYZ_D65_TO_REC2020 and scene_white_xyz = XYZ_D65.
//      - Non-FM Bradford branch: m = m_pro_to_rec2020 × inv_pro × brad(D65→D50) × M_REC2020_TO_XYZ_D65
//        = M_XYZ_D65_TO_REC2020 × brad(D50→D65) × brad(D65→D50) × M_REC2020_TO_XYZ_D65
//        = M_XYZ_D65_TO_REC2020 × M_REC2020_TO_XYZ_D65 = identity.
//      Combined transform is identity — rendered RGB values are preserved
//      (within 16-bit quantization and soft_floor clamping of negatives).

const TAG_NEW_SUBFILE_TYPE: u16 = 254;
const TAG_IMAGE_WIDTH: u16 = 256;
const TAG_IMAGE_LENGTH: u16 = 257;
const TAG_BITS_PER_SAMPLE: u16 = 258;
const TAG_COMPRESSION: u16 = 259;
const TAG_PHOTOMETRIC: u16 = 262;
const TAG_STRIP_OFFSETS: u16 = 273;
const TAG_SAMPLES_PER_PIXEL: u16 = 277;
const TAG_ROWS_PER_STRIP: u16 = 278;
const TAG_STRIP_BYTE_COUNTS: u16 = 279;
const TAG_PLANAR_CONFIG: u16 = 284;
const TAG_EXIF_IFD_POINTER: u16 = 0x8769;
const TAG_DNG_VERSION: u16 = 50706;
const TAG_DNG_BACKWARD_VERSION: u16 = 50707;
const TAG_UNIQUE_CAMERA_MODEL: u16 = 50708;
const TAG_WHITE_LEVEL: u16 = 50717;
const TAG_COLOR_MATRIX_1: u16 = 50721;
const TAG_CAMERA_CALIBRATION_1: u16 = 50723;
const TAG_ANALOG_BALANCE: u16 = 50727;
const TAG_AS_SHOT_NEUTRAL: u16 = 50728;
const TAG_BASELINE_EXPOSURE: u16 = 50730;
const TAG_CALIBRATION_ILLUMINANT_1: u16 = 50778;

// ExifIFD tags
const TAG_EXIF_FOCAL_LENGTH: u16 = 0x920A;
const TAG_EXIF_FOCAL_LENGTH_35MM: u16 = 0xA405;

/// LinearRaw photometric (DNG spec §6.3).
const PHOTOMETRIC_LINEAR_RAW: u16 = 34892;
const CALIBRATION_ILLUMINANT_D65: u16 = 21;

/// Write one synthetic frame as a LinearRaw DNG (3 channels, interleaved).
///
/// `rgb16` is interleaved RGB 16-bit data (`width * height * 3` values)
/// as returned by `render_frame`.
fn write_linearraw_dng(
    path: &std::path::Path,
    width: u32,
    height: u32,
    rgb16: &[u16],
    focal_mm_num: u32,
    focal_mm_den: u32,
    focal_35mm: u16,
) -> io::Result<()> {
    let bytes = build_linearraw_dng(width, height, rgb16, focal_mm_num, focal_mm_den, focal_35mm);
    std::fs::write(path, bytes)
}

fn build_linearraw_dng(
    width: u32,
    height: u32,
    rgb16: &[u16],
    focal_mm_num: u32,
    focal_mm_den: u32,
    focal_35mm: u16,
) -> Vec<u8> {
    // Pixel strip: interleaved RGB, 3 × 2 bytes per pixel.
    let strip_byte_count = (width as usize) * (height as usize) * 3 * 2;

    // Two-pass layout.
    let (ifd0_probe, exif_probe) = build_ifds(
        width,
        height,
        strip_byte_count as u32,
        0,
        0,
        focal_mm_num,
        focal_mm_den,
        focal_35mm,
    );

    let header_size: usize = 8;
    let ifd0_size = ifd0_probe.len();
    let exif_size = exif_probe.len();

    let exif_offset = (header_size + ifd0_size) as u32;
    let strip_offset = (header_size + ifd0_size + exif_size) as u32;

    let (ifd0_bytes, exif_bytes) = build_ifds(
        width,
        height,
        strip_byte_count as u32,
        strip_offset,
        exif_offset,
        focal_mm_num,
        focal_mm_den,
        focal_35mm,
    );

    let total = header_size + ifd0_bytes.len() + exif_bytes.len() + strip_byte_count;
    let mut buf: Vec<u8> = Vec::with_capacity(total);

    // TIFF II (little-endian) header
    buf.extend_from_slice(b"II");
    write_u16_le(&mut buf, 0x002A);
    write_u32_le(&mut buf, 8); // IFD0 at offset 8

    buf.extend_from_slice(&ifd0_bytes);
    buf.extend_from_slice(&exif_bytes);

    // Pixel strip: interleaved RGB16 (big-endian per TIFF spec; rawler handles
    // endianness via the II/MM header — with II header, 16-bit samples are LE).
    for &v in rgb16 {
        write_u16_le(&mut buf, v);
    }

    buf
}

fn build_ifds(
    width: u32,
    height: u32,
    strip_byte_count: u32,
    strip_offset: u32,
    exif_ifd_offset: u32,
    focal_mm_num: u32,
    focal_mm_den: u32,
    focal_35mm: u16,
) -> (Vec<u8>, Vec<u8>) {
    // ── IFD0 ──
    let mut ifd0: Vec<(u16, IfdVal)> = Vec::new();
    ifd0.push((TAG_NEW_SUBFILE_TYPE, IfdVal::Long(0)));
    ifd0.push((TAG_IMAGE_WIDTH, IfdVal::Long(width)));
    ifd0.push((TAG_IMAGE_LENGTH, IfdVal::Long(height)));
    // BitsPerSample = [16, 16, 16] for 3 channels
    ifd0.push((TAG_BITS_PER_SAMPLE, IfdVal::Shorts(vec![16, 16, 16])));
    ifd0.push((TAG_COMPRESSION, IfdVal::Short(1))); // uncompressed
    ifd0.push((TAG_PHOTOMETRIC, IfdVal::Short(PHOTOMETRIC_LINEAR_RAW)));
    ifd0.push((TAG_STRIP_OFFSETS, IfdVal::Long(strip_offset)));
    ifd0.push((TAG_SAMPLES_PER_PIXEL, IfdVal::Short(3)));
    ifd0.push((TAG_ROWS_PER_STRIP, IfdVal::Long(height)));
    ifd0.push((TAG_STRIP_BYTE_COUNTS, IfdVal::Long(strip_byte_count)));
    ifd0.push((TAG_PLANAR_CONFIG, IfdVal::Short(1))); // chunky interleaved
    ifd0.push((TAG_EXIF_IFD_POINTER, IfdVal::Long(exif_ifd_offset)));
    ifd0.push((TAG_DNG_VERSION, IfdVal::Bytes(vec![1, 4, 0, 0])));
    ifd0.push((TAG_DNG_BACKWARD_VERSION, IfdVal::Bytes(vec![1, 0, 0, 0])));
    ifd0.push((
        TAG_UNIQUE_CAMERA_MODEL,
        IfdVal::Ascii("Maple Synthetic Pano".to_string()),
    ));
    // BlackLevel intentionally omitted for LinearRaw: rawler's get_blacklevels
    // reads a missing tag as Ok(None) and falls back to BlackLevel::zero(1,1,cpp),
    // which is correct for synthetic data with black=0.
    // Writing BlackLevel as a single SHORT panics (rawler asserts levels.len() ==
    // width*height*cpp = 3 for a 3-channel LinearRaw).
    ifd0.push((TAG_WHITE_LEVEL, IfdVal::Short(65535)));
    // ColorMatrix1 = identity (render output is already in D65 working space)
    ifd0.push((
        TAG_COLOR_MATRIX_1,
        IfdVal::SRationals(vec![
            (1_000_000, 1_000_000),
            (0, 1_000_000),
            (0, 1_000_000),
            (0, 1_000_000),
            (1_000_000, 1_000_000),
            (0, 1_000_000),
            (0, 1_000_000),
            (0, 1_000_000),
            (1_000_000, 1_000_000),
        ]),
    ));
    // CameraCalibration1 = identity
    ifd0.push((
        TAG_CAMERA_CALIBRATION_1,
        IfdVal::SRationals(vec![
            (1_000_000, 1_000_000),
            (0, 1_000_000),
            (0, 1_000_000),
            (0, 1_000_000),
            (1_000_000, 1_000_000),
            (0, 1_000_000),
            (0, 1_000_000),
            (0, 1_000_000),
            (1_000_000, 1_000_000),
        ]),
    ));
    // AnalogBalance = (1, 1, 1)
    ifd0.push((
        TAG_ANALOG_BALANCE,
        IfdVal::Rationals(vec![(1_000_000, 1_000_000); 3]),
    ));
    // AsShotNeutral = (1, 1, 1) — balanced neutral; WB gain = (1, 1, 1) → no scaling.
    // The render output is already scene-linear and we want it to stay that way.
    ifd0.push((
        TAG_AS_SHOT_NEUTRAL,
        IfdVal::Rationals(vec![
            (1_000_000, 1_000_000),
            (1_000_000, 1_000_000),
            (1_000_000, 1_000_000),
        ]),
    ));
    ifd0.push((TAG_BASELINE_EXPOSURE, IfdVal::SRationals(vec![(0, 1)])));
    ifd0.push((
        TAG_CALIBRATION_ILLUMINANT_1,
        IfdVal::Short(CALIBRATION_ILLUMINANT_D65),
    ));

    ifd0.sort_by_key(|(tag, _)| *tag);
    let ifd0_bytes = serialize_ifd(&ifd0, 8u32);

    // ── ExifIFD ──
    let mut exif: Vec<(u16, IfdVal)> = Vec::new();
    // FocalLength as RATIONAL (mm): written as num/den * 1_000_000 to match
    // rational precision expected by rawler's metadata pass (n/d → f32).
    exif.push((
        TAG_EXIF_FOCAL_LENGTH,
        IfdVal::Rationals(vec![(focal_mm_num * 1_000_000, focal_mm_den * 1_000_000)]),
    ));
    // FocalLengthIn35mmFormat as SHORT (integer-rounded, per camera firmware convention)
    exif.push((TAG_EXIF_FOCAL_LENGTH_35MM, IfdVal::Short(focal_35mm)));

    exif.sort_by_key(|(tag, _)| *tag);
    let exif_bytes = serialize_ifd(&exif, exif_ifd_offset);

    (ifd0_bytes, exif_bytes)
}

// ─── Simple IFD value types ───────────────────────────────────────────────────

#[derive(Clone)]
enum IfdVal {
    Short(u16),
    Shorts(Vec<u16>),
    Long(u32),
    Bytes(Vec<u8>),
    Ascii(String),
    Rationals(Vec<(u32, u32)>),
    SRationals(Vec<(i32, i32)>),
}

impl IfdVal {
    fn type_id(&self) -> u16 {
        match self {
            IfdVal::Short(_) | IfdVal::Shorts(_) => 3,
            IfdVal::Long(_) => 4,
            IfdVal::Bytes(_) => 1,
            IfdVal::Ascii(_) => 2,
            IfdVal::Rationals(_) => 5,
            IfdVal::SRationals(_) => 10,
        }
    }

    fn count(&self) -> u32 {
        match self {
            IfdVal::Short(_) => 1,
            IfdVal::Shorts(v) => v.len() as u32,
            IfdVal::Long(_) => 1,
            IfdVal::Bytes(v) => v.len() as u32,
            IfdVal::Ascii(s) => s.len() as u32 + 1,
            IfdVal::Rationals(v) => v.len() as u32,
            IfdVal::SRationals(v) => v.len() as u32,
        }
    }

    fn payload(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        match self {
            IfdVal::Short(v) => write_u16_le(&mut buf, *v),
            IfdVal::Shorts(v) => {
                for &x in v {
                    write_u16_le(&mut buf, x);
                }
            }
            IfdVal::Long(v) => write_u32_le(&mut buf, *v),
            IfdVal::Bytes(v) => buf.extend_from_slice(v),
            IfdVal::Ascii(s) => {
                buf.extend_from_slice(s.as_bytes());
                buf.push(0);
            }
            IfdVal::Rationals(v) => {
                for (n, d) in v {
                    write_u32_le(&mut buf, *n);
                    write_u32_le(&mut buf, *d);
                }
            }
            IfdVal::SRationals(v) => {
                for (n, d) in v {
                    buf.extend_from_slice(&n.to_le_bytes());
                    buf.extend_from_slice(&d.to_le_bytes());
                }
            }
        }
        buf
    }
}

fn serialize_ifd(entries: &[(u16, IfdVal)], ifd_file_offset: u32) -> Vec<u8> {
    let n = entries.len() as u16;
    let dir_size: u32 = 2 + 12 * (n as u32) + 4;
    let mut overflow_offset = ifd_file_offset + dir_size;
    let mut overflow: Vec<u8> = Vec::new();

    let mut buf: Vec<u8> = Vec::new();
    write_u16_le(&mut buf, n);

    for (tag, val) in entries {
        let payload = val.payload();
        write_u16_le(&mut buf, *tag);
        write_u16_le(&mut buf, val.type_id());
        write_u32_le(&mut buf, val.count());
        if payload.len() <= 4 {
            let mut padded = payload.clone();
            padded.resize(4, 0);
            buf.extend_from_slice(&padded);
        } else {
            write_u32_le(&mut buf, overflow_offset);
            overflow_offset += payload.len() as u32;
            overflow.extend_from_slice(&payload);
            if overflow.len() % 2 != 0 {
                overflow.push(0);
                overflow_offset += 1;
            }
        }
    }
    write_u32_le(&mut buf, 0); // next-IFD = 0
    buf.extend_from_slice(&overflow);
    buf
}

fn write_u16_le(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn write_u32_le(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

//! LinearRaw DNG writer for `pano-gen-fixture`.
//!
//! PhotometricInterpretation = LinearRaw (34892), SamplesPerPixel = 3,
//! BitsPerSample = 16, interleaved [R0 G0 B0 R1 G1 B1 ...].
//!
//! Decode chain through decode_for_pano / pano/mod.rs:
//!   1. linearraw_to_camera_rgb  → normalizes u16 by white_level (65535) → [0,1]
//!   2. DNG DefaultCrop          → no-op (none written)
//!   3. BaselineExposure         → no-op (0.0 written)
//!   4. WB pre-gain (AsShotNeutral=[1,1,1]) → scale by 1/1 per channel → no-op
//!   5. highlight recovery
//!   6. DCP apply_colorimetry:
//!      - ColorMatrix1 = identity is filtered by `is_approx_identity` in
//!        profile_from_embedded → falls to step-4 rawler fallback which sets
//!        CM = M_XYZ_D65_TO_REC2020 and scene_white_xyz = XYZ_D65.
//!      - Non-FM Bradford branch: m = m_pro_to_rec2020 × inv_pro × brad(D65→D50) × M_REC2020_TO_XYZ_D65
//!        = M_XYZ_D65_TO_REC2020 × brad(D50→D65) × brad(D65→D50) × M_REC2020_TO_XYZ_D65
//!        = M_XYZ_D65_TO_REC2020 × M_REC2020_TO_XYZ_D65 = identity.
//!      Combined transform is identity — rendered RGB values are preserved
//!      (within 16-bit quantization and soft_floor clamping of negatives).

use std::io;

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
pub fn write_linearraw_dng(
    path: &std::path::Path,
    width: u32,
    height: u32,
    rgb16: &[u16],
    focal_mm_num: u32,
    focal_mm_den: u32,
    focal_35mm: u16,
) -> io::Result<()> {
    // Validate up front: the IFD strip byte-counts are derived from
    // width*height*3, so a mismatched slice would write a malformed DNG
    // (declared StripByteCounts != actual payload).
    let expected = width as usize * height as usize * 3;
    if rgb16.len() != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "rgb16 length {} != width*height*3 = {expected} ({width}x{height})",
                rgb16.len()
            ),
        ));
    }
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

    // Pixel strip: interleaved RGB16, little-endian to match the "II" TIFF
    // header written above (rawler reads sample endianness from that header).
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
    // FocalLength as RATIONAL (mm), written unscaled. rawler computes n/d as
    // f32, so (30, 1) decodes identically to (30e6, 1e6); the unscaled form
    // avoids any u32 wraparound for large focal lengths (small-FOV inputs).
    exif.push((
        TAG_EXIF_FOCAL_LENGTH,
        IfdVal::Rationals(vec![(focal_mm_num, focal_mm_den)]),
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

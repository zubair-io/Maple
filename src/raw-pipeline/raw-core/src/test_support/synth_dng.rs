//! Synthetic Bayer DNG writer — see Task 2 onward.

use crate::color::illuminant::Illuminant;
use crate::image::CfaPattern;
use std::io;
use std::path::Path;

// DNG-specific TIFF tag IDs. Subset of what raw-core's decoder reads.
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
const TAG_CFA_REPEAT_PATTERN_DIM: u16 = 33421;
const TAG_CFA_PATTERN: u16 = 33422;
const TAG_DNG_VERSION: u16 = 50706;
const TAG_DNG_BACKWARD_VERSION: u16 = 50707;
const TAG_UNIQUE_CAMERA_MODEL: u16 = 50708;
const TAG_BLACK_LEVEL: u16 = 50714;
const TAG_WHITE_LEVEL: u16 = 50717;
const TAG_COLOR_MATRIX_1: u16 = 50721;
const TAG_CAMERA_CALIBRATION_1: u16 = 50723;
const TAG_ANALOG_BALANCE: u16 = 50727;
const TAG_AS_SHOT_NEUTRAL: u16 = 50728;
const TAG_BASELINE_EXPOSURE: u16 = 50730;
const TAG_CALIBRATION_ILLUMINANT_1: u16 = 50778;
const TAG_COLOR_MATRIX_2: u16 = 50722;
const TAG_FORWARD_MATRIX_1: u16 = 50964;
const TAG_FORWARD_MATRIX_2: u16 = 50965;
const TAG_PROFILE_TONE_CURVE: u16 = 50940;
const TAG_CALIBRATION_ILLUMINANT_2: u16 = 50779;
// DNG LinearizationTable, spec § "Linearization Table". Tag 50712 / 0xC618.
// Per-value LUT: encoded sensor codes → linear codes. SHORT-typed, up to
// `1 << BitsPerSample` entries. Rawler applies it inside the integer decode
// path (rawler/src/decoders/mod.rs:641-642) before `raw_data` reaches us.
const TAG_LINEARIZATION_TABLE: u16 = 50712;

// CFA-photometric value
const PHOTOMETRIC_CFA: u16 = 32803;

// Illuminant code: 21 = D65 per EXIF spec.
const CALIBRATION_ILLUMINANT_D65: u16 = 21;

/// Synthesised Bayer DNG with a flat scene-linear neutral patch. See spec
/// `.archived-plans/specs/2026-04-28-synthetic-grey-dng-design.md`.
#[derive(Clone, Debug)]
pub struct SyntheticGreyDng {
    /// Scene-linear neutral target after black subtract + WB. Range 0.0-1.0.
    pub linear_value: f32,
    pub width: u32,
    pub height: u32,
    pub cfa: CfaPattern,
    pub illuminant: Illuminant,

    // Phase 1 DCP additions — None preserves existing test behavior.
    pub color_matrix_1_override: Option<[[f32; 3]; 3]>,
    pub color_matrix_2: Option<[[f32; 3]; 3]>,
    pub calibration_illuminant_1_override: Option<u16>,
    pub calibration_illuminant_2: Option<u16>,
    pub forward_matrix_1: Option<[[f32; 3]; 3]>,
    pub forward_matrix_2: Option<[[f32; 3]; 3]>,
    pub profile_tone_curve: Option<Vec<(f32, f32)>>,
    pub as_shot_neutral_override: Option<[f32; 3]>,

    /// DNG `LinearizationTable` (tag 50712 / 0xC618). Per-value LUT from
    /// encoded sensor codes to linear codes; `table[encoded] = linear`. When
    /// set, the writer emits a SHORT-array entry of `table.len()` entries.
    ///
    /// Note: this field and `encoded_value_override` are independent in
    /// `build_strip()` — setting the table alone leaves the strip on the
    /// `linear_value` / WB-driven path, which produces already-linearised
    /// codes so the LUT becomes a no-op. Tests that exercise the LUT
    /// therefore typically set both fields: the table here, and
    /// `encoded_value_override` to a sentinel encoded code so the strip
    /// carries that exact pre-LUT value for an unambiguous round-trip.
    pub linearization_table: Option<Vec<u16>>,
    /// When set, every CFA position in the strip is written as this u16,
    /// bypassing the `linear_value` / `compute_raw_values` path. Used by
    /// the LinearizationTable round-trip test (#418) to pin the encoded
    /// code rawler will look up in the LUT — assertions then check that
    /// `raw.raw_data[k] ≈ table[encoded_value_override]`.
    pub encoded_value_override: Option<u16>,
}

impl Default for SyntheticGreyDng {
    fn default() -> Self {
        Self {
            linear_value: 0.18,
            width: 64,
            height: 64,
            cfa: CfaPattern::Rggb,
            illuminant: Illuminant::D65,
            color_matrix_1_override: None,
            color_matrix_2: None,
            calibration_illuminant_1_override: None,
            calibration_illuminant_2: None,
            forward_matrix_1: None,
            forward_matrix_2: None,
            profile_tone_curve: None,
            as_shot_neutral_override: None,
            linearization_table: None,
            encoded_value_override: None,
        }
    }
}

impl SyntheticGreyDng {
    pub fn write_to(&self, path: &Path) -> io::Result<()> {
        std::fs::write(path, self.write_to_bytes())
    }

    /// Inject the real Hasselblad L3D-100c dual-CM data from
    /// test_0000.DNG. Replaces ColorMatrix1 (was identity) with the
    /// StdA matrix, sets ColorMatrix2 to the D65 matrix, sets
    /// AsShotNeutral to the real Hasselblad value (~[0.37, 1.0, 0.68]).
    pub fn with_hasselblad_dcp(mut self) -> Self {
        use crate::test_support::hasselblad_dcp::*;
        self.color_matrix_1_override = Some(COLOR_MATRIX_1);
        self.calibration_illuminant_1_override = Some(CALIBRATION_ILLUMINANT_1);
        self.color_matrix_2 = Some(COLOR_MATRIX_2);
        self.calibration_illuminant_2 = Some(CALIBRATION_ILLUMINANT_2);
        self.as_shot_neutral_override = Some(AS_SHOT_NEUTRAL);
        self
    }

    /// Hand-crafted simple S-curve PTC: 5 control points,
    /// (0, 0), (0.18, 0.15), (0.5, 0.55), (0.82, 0.9), (1.0, 1.0).
    /// Slight contrast lift in the midtones, monotonic.
    pub fn with_simple_tone_curve(mut self) -> Self {
        self.profile_tone_curve = Some(vec![
            (0.0, 0.0),
            (0.18, 0.15),
            (0.5, 0.55),
            (0.82, 0.9),
            (1.0, 1.0),
        ]);
        self
    }

    pub fn write_to_bytes(&self) -> Vec<u8> {
        // Layout:
        //   [TIFF header 8 bytes]
        //   [IFD0 directory + overflow data]
        //   [pixel strip]
        //
        // We assemble the IFD into a probe buffer first to learn its size,
        // then re-serialise with the real strip offset and pad pixels last.

        let header_size: u32 = 8;
        let ifd0_offset = header_size;
        let strip_byte_count = (self.width as usize) * (self.height as usize) * 2;

        // First pass: build with a dummy strip offset to learn IFD size.
        let probe_ifd = self.build_ifd0(/*strip_offset*/ 0);
        let mut probe_buf = Vec::new();
        probe_ifd.serialise_into(&mut probe_buf, ifd0_offset);
        let ifd_size = probe_buf.len() as u32;

        // Real strip offset = after header + IFD.
        let strip_offset = ifd0_offset + ifd_size;

        // Second pass: real IFD with correct strip offset.
        let real_ifd = self.build_ifd0(strip_offset);
        let mut buf: Vec<u8> =
            Vec::with_capacity((header_size as usize) + (ifd_size as usize) + strip_byte_count);

        // Header
        buf.extend_from_slice(b"II"); // little-endian
        write_u16_le(&mut buf, 0x002A); // TIFF magic
        write_u32_le(&mut buf, ifd0_offset);

        // IFD0 directory + overflow
        real_ifd.serialise_into(&mut buf, ifd0_offset);

        // Pixel strip
        let strip = self.build_strip();
        buf.extend_from_slice(&strip);

        buf
    }

    fn build_ifd0(&self, strip_offset: u32) -> Ifd {
        let strip_byte_count = (self.width as u32) * (self.height as u32) * 2;

        let mut ifd = Ifd::new();
        ifd.add_long(TAG_NEW_SUBFILE_TYPE, 0);
        ifd.add_long(TAG_IMAGE_WIDTH, self.width);
        ifd.add_long(TAG_IMAGE_LENGTH, self.height);
        ifd.add_short(TAG_BITS_PER_SAMPLE, 16);
        ifd.add_short(TAG_COMPRESSION, 1); // uncompressed
        ifd.add_short(TAG_PHOTOMETRIC, PHOTOMETRIC_CFA);
        ifd.add_long(TAG_STRIP_OFFSETS, strip_offset);
        ifd.add_short(TAG_SAMPLES_PER_PIXEL, 1);
        ifd.add_long(TAG_ROWS_PER_STRIP, self.height);
        ifd.add_long(TAG_STRIP_BYTE_COUNTS, strip_byte_count);
        ifd.add_short(TAG_PLANAR_CONFIG, 1); // chunky

        // CFA: 2x2 pattern, RGGB bytes
        ifd.add_shorts(TAG_CFA_REPEAT_PATTERN_DIM, vec![2, 2]);
        ifd.add_bytes(TAG_CFA_PATTERN, self.cfa_pattern_bytes());

        // DNG identity
        ifd.add_bytes(TAG_DNG_VERSION, vec![1, 4, 0, 0]);
        ifd.add_bytes(TAG_DNG_BACKWARD_VERSION, vec![1, 0, 0, 0]);
        ifd.add_ascii(TAG_UNIQUE_CAMERA_MODEL, "Maple Synthetic");

        // Linearisation
        ifd.add_short(TAG_BLACK_LEVEL, 0);
        ifd.add_short(TAG_WHITE_LEVEL, 65535);

        // ColorMatrix1: identity unless override set (Hasselblad / similar).
        let cm1 = self.color_matrix_1_override.unwrap_or([
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ]);
        ifd.add_srationals(TAG_COLOR_MATRIX_1, matrix_to_srationals(cm1));

        // CameraCalibration1 stays identity always.
        ifd.add_srationals(
            TAG_CAMERA_CALIBRATION_1,
            vec![
                (1, 1),
                (0, 1),
                (0, 1),
                (0, 1),
                (1, 1),
                (0, 1),
                (0, 1),
                (0, 1),
                (1, 1),
            ],
        );

        ifd.add_rationals(TAG_ANALOG_BALANCE, vec![(1, 1), (1, 1), (1, 1)]);

        let asn = self.as_shot_neutral_override.unwrap_or([0.5, 1.0, 0.5]);
        ifd.add_rationals(TAG_AS_SHOT_NEUTRAL, vec3_to_rationals(asn));

        ifd.add_srationals(TAG_BASELINE_EXPOSURE, vec![(0, 1)]);

        let illum1 = self
            .calibration_illuminant_1_override
            .unwrap_or(CALIBRATION_ILLUMINANT_D65);
        ifd.add_short(TAG_CALIBRATION_ILLUMINANT_1, illum1);

        // Phase 1 optional fields.
        if let Some(cm2) = self.color_matrix_2 {
            ifd.add_srationals(TAG_COLOR_MATRIX_2, matrix_to_srationals(cm2));
        }
        if let Some(illum2) = self.calibration_illuminant_2 {
            ifd.add_short(TAG_CALIBRATION_ILLUMINANT_2, illum2);
        }
        if let Some(fm1) = self.forward_matrix_1 {
            ifd.add_srationals(TAG_FORWARD_MATRIX_1, matrix_to_srationals(fm1));
        }
        if let Some(fm2) = self.forward_matrix_2 {
            ifd.add_srationals(TAG_FORWARD_MATRIX_2, matrix_to_srationals(fm2));
        }
        if let Some(curve) = &self.profile_tone_curve {
            // ProfileToneCurve is FLOAT-typed (DNG spec); pack (input, output)
            // pairs as raw 32-bit floats.
            let mut bytes = Vec::with_capacity(curve.len() * 8);
            for (x, y) in curve {
                bytes.extend_from_slice(&x.to_le_bytes());
                bytes.extend_from_slice(&y.to_le_bytes());
            }
            ifd.entries
                .push(IfdEntry::Floats(TAG_PROFILE_TONE_CURVE, bytes));
        }

        if let Some(table) = &self.linearization_table {
            // SHORT-typed per DNG spec. Rawler reads it via
            // `Value::Short(points)` and panics on any other type — so we
            // must use the SHORT path here, not BYTE / LONG.
            ifd.add_shorts(TAG_LINEARIZATION_TABLE, table.clone());
        }

        ifd
    }

    fn build_strip(&self) -> Vec<u8> {
        // When the LinearizationTable test pins the encoded code, every CFA
        // position carries the same u16; the LUT plus WB produces the scene
        // neutral on the decoder side. Otherwise compute per-position raw
        // codes from `linear_value` + AsShotNeutral as before.
        let (raw_r, raw_g, raw_b) = if let Some(v) = self.encoded_value_override {
            (v, v, v)
        } else {
            compute_raw_values(self.linear_value, self.as_shot_neutral_array(), 0, 65535)
        };
        let n = (self.width as usize) * (self.height as usize);
        let mut buf = Vec::with_capacity(n * 2);
        // Walk row-major, emit 16-bit LE per CFA position.
        for y in 0..self.height {
            for x in 0..self.width {
                let v = match self.cfa.color_at(x, y) {
                    0 => raw_r,
                    1 => raw_g,
                    2 => raw_b,
                    _ => unreachable!(),
                };
                write_u16_le(&mut buf, v);
            }
        }
        buf
    }

    fn cfa_pattern_bytes(&self) -> Vec<u8> {
        // 4 bytes for 2x2 pattern, 0=R, 1=G, 2=B
        match self.cfa {
            CfaPattern::Rggb => vec![0, 1, 1, 2],
            CfaPattern::Bggr => vec![2, 1, 1, 0],
            CfaPattern::Grbg => vec![1, 0, 2, 1],
            CfaPattern::Gbrg => vec![1, 2, 0, 1],
            CfaPattern::LinearRgb => panic!(
                "SyntheticGreyDng with CfaPattern::LinearRgb is unsupported \
                 — synthesise a Bayer pattern (Rggb/Bggr/Grbg/Gbrg) instead"
            ),
            CfaPattern::XTrans(_) => panic!(
                "SyntheticGreyDng with CfaPattern::XTrans is unsupported \
                 (the synthetic-DNG writer emits a 2×2 Bayer CFAPattern tag)"
            ),
        }
    }

    fn as_shot_neutral_array(&self) -> [f32; 3] {
        // Honour the override if set — keeps the raw bayer values consistent
        // with the AsShotNeutral tag emitted by `build_ifd0`. Without this
        // alignment, decode would apply the IFD's WB to raw values computed
        // for a different WB, producing non-neutral scene-linear from a
        // synthesized neutral input.
        self.as_shot_neutral_override.unwrap_or([0.5, 1.0, 0.5])
    }
}

const TYPE_BYTE: u16 = 1;
const TYPE_ASCII: u16 = 2;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_RATIONAL: u16 = 5;
const TYPE_SRATIONAL: u16 = 10;
const TYPE_FLOAT: u16 = 11;

/// Convert a 3×3 f32 matrix to (i32, i32) srational pairs at 1e-6 precision.
pub(crate) fn matrix_to_srationals(m: [[f32; 3]; 3]) -> Vec<(i32, i32)> {
    const SCALE: f32 = 1_000_000.0;
    let mut out = Vec::with_capacity(9);
    for row in 0..3 {
        for col in 0..3 {
            let n = (m[row][col] * SCALE).round() as i32;
            out.push((n, SCALE as i32));
        }
    }
    out
}

/// Convert a [f32; 3] to (u32, u32) rational triples at 1e-6 precision.
pub(crate) fn vec3_to_rationals(v: [f32; 3]) -> Vec<(u32, u32)> {
    const SCALE: f32 = 1_000_000.0;
    v.iter()
        .map(|&x| ((x * SCALE).round() as u32, SCALE as u32))
        .collect()
}

#[derive(Clone)]
pub(crate) enum IfdEntry {
    Short(u16, u16),                  // tag, value (single)
    Shorts(u16, Vec<u16>),            // tag, values
    Long(u16, u32),                   // tag, value (single)
    Bytes(u16, Vec<u8>),              // tag, values (count = len)
    Ascii(u16, String),               // tag, NUL-terminated ASCII
    Rationals(u16, Vec<(u32, u32)>),  // tag, num/den pairs
    SRationals(u16, Vec<(i32, i32)>), // tag, signed num/den
    Floats(u16, Vec<u8>),             // tag, raw bytes of f32 LE values (count = len/4)
}

impl IfdEntry {
    fn tag(&self) -> u16 {
        match self {
            Self::Short(t, _) => *t,
            Self::Shorts(t, _) => *t,
            Self::Long(t, _) => *t,
            Self::Bytes(t, _) => *t,
            Self::Ascii(t, _) => *t,
            Self::Rationals(t, _) => *t,
            Self::SRationals(t, _) => *t,
            Self::Floats(t, _) => *t,
        }
    }

    fn type_id(&self) -> u16 {
        match self {
            Self::Short(_, _) | Self::Shorts(_, _) => TYPE_SHORT,
            Self::Long(_, _) => TYPE_LONG,
            Self::Bytes(_, _) => TYPE_BYTE,
            Self::Ascii(_, _) => TYPE_ASCII,
            Self::Rationals(_, _) => TYPE_RATIONAL,
            Self::SRationals(_, _) => TYPE_SRATIONAL,
            Self::Floats(_, _) => TYPE_FLOAT,
        }
    }

    fn count(&self) -> u32 {
        match self {
            Self::Short(_, _) => 1,
            Self::Shorts(_, v) => v.len() as u32,
            Self::Long(_, _) => 1,
            Self::Bytes(_, v) => v.len() as u32,
            Self::Ascii(_, s) => s.len() as u32 + 1, // includes NUL
            Self::Rationals(_, v) => v.len() as u32,
            Self::SRationals(_, v) => v.len() as u32,
            Self::Floats(_, v) => (v.len() / 4) as u32,
        }
    }

    /// Serialise the value payload into a fresh buffer (either the full
    /// payload for overflow, or the same bytes that go in the inline value
    /// slot — caller pads to 4 bytes when inline).
    fn payload_bytes_vec(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        match self {
            Self::Short(_, v) => write_u16_le(&mut buf, *v),
            Self::Shorts(_, v) => {
                for &x in v {
                    write_u16_le(&mut buf, x);
                }
            }
            Self::Long(_, v) => write_u32_le(&mut buf, *v),
            Self::Bytes(_, v) => buf.extend_from_slice(v),
            Self::Ascii(_, s) => {
                buf.extend_from_slice(s.as_bytes());
                buf.push(0); // NUL
            }
            Self::Rationals(_, v) => {
                for (n, d) in v {
                    write_rational(&mut buf, *n, *d);
                }
            }
            Self::SRationals(_, v) => {
                for (n, d) in v {
                    write_srational(&mut buf, *n, *d);
                }
            }
            Self::Floats(_, v) => buf.extend_from_slice(v),
        }
        buf
    }
}

pub(crate) struct Ifd {
    pub(crate) entries: Vec<IfdEntry>,
}

impl Ifd {
    pub(crate) fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub(crate) fn add_short(&mut self, tag: u16, value: u16) {
        self.entries.push(IfdEntry::Short(tag, value));
    }
    pub(crate) fn add_shorts(&mut self, tag: u16, values: Vec<u16>) {
        self.entries.push(IfdEntry::Shorts(tag, values));
    }
    pub(crate) fn add_long(&mut self, tag: u16, value: u32) {
        self.entries.push(IfdEntry::Long(tag, value));
    }
    pub(crate) fn add_bytes(&mut self, tag: u16, values: Vec<u8>) {
        self.entries.push(IfdEntry::Bytes(tag, values));
    }
    pub(crate) fn add_ascii(&mut self, tag: u16, s: &str) {
        self.entries.push(IfdEntry::Ascii(tag, s.to_string()));
    }
    pub(crate) fn add_rationals(&mut self, tag: u16, v: Vec<(u32, u32)>) {
        self.entries.push(IfdEntry::Rationals(tag, v));
    }
    pub(crate) fn add_srationals(&mut self, tag: u16, v: Vec<(i32, i32)>) {
        self.entries.push(IfdEntry::SRationals(tag, v));
    }

    /// Serialise: sort entries by tag, then write
    ///   [u16 count][12-byte entry × N][u32 next=0][overflow bytes...]
    /// `file_offset` is the absolute file position where this IFD starts —
    /// needed to compute correct overflow-data offsets.
    pub(crate) fn serialise_into(mut self, buf: &mut Vec<u8>, file_offset: u32) {
        self.entries.sort_by_key(|e| e.tag());
        let n = self.entries.len() as u16;

        // Directory size: 2 (count) + 12 * n + 4 (next-IFD).
        let dir_size = 2 + 12 * (n as u32) + 4;
        let mut overflow_cursor = file_offset + dir_size;
        let mut overflow_buf: Vec<u8> = Vec::new();

        write_u16_le(buf, n);
        for entry in &self.entries {
            write_u16_le(buf, entry.tag());
            write_u16_le(buf, entry.type_id());
            write_u32_le(buf, entry.count());
            let payload = entry.payload_bytes_vec();
            if payload.len() <= 4 {
                // Inline. Pad to 4 bytes with zeros.
                let mut padded = payload.clone();
                padded.resize(4, 0);
                buf.extend_from_slice(&padded);
            } else {
                // Overflow. Value slot holds absolute file offset.
                write_u32_le(buf, overflow_cursor);
                overflow_cursor += payload.len() as u32;
                overflow_buf.extend_from_slice(&payload);
                // Pad overflow to even byte boundary per TIFF spec.
                if overflow_buf.len() % 2 != 0 {
                    overflow_buf.push(0);
                    overflow_cursor += 1;
                }
            }
        }
        // Next-IFD offset (0 = last).
        write_u32_le(buf, 0);
        // Overflow data follows directory.
        buf.extend_from_slice(&overflow_buf);
    }
}

pub(crate) fn write_u16_le(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

pub(crate) fn write_u32_le(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

pub(crate) fn write_rational(buf: &mut Vec<u8>, num: u32, den: u32) {
    write_u32_le(buf, num);
    write_u32_le(buf, den);
}

pub(crate) fn write_srational(buf: &mut Vec<u8>, num: i32, den: i32) {
    buf.extend_from_slice(&num.to_le_bytes());
    buf.extend_from_slice(&den.to_le_bytes());
}

/// Compute per-CFA-position 16-bit raw values that decode to a uniform
/// scene-linear neutral `linear_value` after black subtract, dynamic-range
/// normalisation, and WB. `as_shot_neutral` follows DNG semantics
/// (camera reading of a neutral, G-normalised). Returns `(raw_r, raw_g, raw_b)`.
pub(crate) fn compute_raw_values(
    linear_value: f32,
    as_shot_neutral: [f32; 3],
    black_level: u16,
    white_level: u16,
) -> (u16, u16, u16) {
    let bl = black_level as f32;
    let wl = white_level as f32;
    let range = wl - bl;
    let wb = [
        1.0 / as_shot_neutral[0],
        1.0 / as_shot_neutral[1],
        1.0 / as_shot_neutral[2],
    ];
    let raw = |w: f32| -> u16 {
        let v = bl + (linear_value / w) * range;
        v.round().clamp(0.0, u16::MAX as f32) as u16
    };
    (raw(wb[0]), raw(wb[1]), raw(wb[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_values_for_l_018_d65_balance() {
        // L = 0.18, AsShotNeutral = (0.5, 1.0, 0.5) → WB = (2.0, 1.0, 2.0).
        // raw = BL + (L / WB) * (WL - BL) = 0 + (0.18/WB) * 65535.
        //   R: 0.18/2.0 * 65535 = 5898.15 → 5898
        //   G: 0.18/1.0 * 65535 = 11796.30 → 11796
        //   B: 0.18/2.0 * 65535 = 5898.15 → 5898
        let (r, g, b) = compute_raw_values(0.18, [0.5, 1.0, 0.5], 0, 65535);
        assert_eq!(r, 5898);
        assert_eq!(g, 11796);
        assert_eq!(b, 5898);
    }

    #[test]
    fn raw_values_clamp_to_white_level() {
        // Drive L past every channel's saturation point. With WB_G = 1.0
        // scene-linear 1.0 needs raw_G = WL; with WB_R = WB_B = 2.0
        // scene-linear 2.0 needs raw_R = raw_B = WL. Pass L = 3.0 to
        // saturate every channel and confirm the clamp fires.
        let (r, g, b) = compute_raw_values(3.0, [0.5, 1.0, 0.5], 0, 65535);
        assert_eq!(r, 65535);
        assert_eq!(g, 65535);
        assert_eq!(b, 65535);
    }

    #[test]
    fn raw_values_unsaturated_at_l_one() {
        // Sanity check: at L = 1.0, only the channel with WB = 1.0 hits WL;
        // the doubled channels land at WL / 2 (rounded) — no clamp needed.
        let (r, g, b) = compute_raw_values(1.0, [0.5, 1.0, 0.5], 0, 65535);
        assert_eq!(g, 65535);
        // 0 + (1.0 / 2.0) * 65535 = 32767.5 → 32768
        assert_eq!(r, 32768);
        assert_eq!(b, 32768);
    }

    #[test]
    fn raw_values_zero_for_zero_l() {
        let (r, g, b) = compute_raw_values(0.0, [0.5, 1.0, 0.5], 100, 65535);
        assert_eq!(r, 100);
        assert_eq!(g, 100);
        assert_eq!(b, 100);
    }

    #[test]
    fn writes_u16_le() {
        let mut buf = Vec::new();
        write_u16_le(&mut buf, 0x1234);
        assert_eq!(buf, vec![0x34, 0x12]);
    }

    #[test]
    fn writes_u32_le() {
        let mut buf = Vec::new();
        write_u32_le(&mut buf, 0xDEAD_BEEF);
        assert_eq!(buf, vec![0xEF, 0xBE, 0xAD, 0xDE]);
    }

    #[test]
    fn writes_rational_le() {
        let mut buf = Vec::new();
        write_rational(&mut buf, 1, 2);
        assert_eq!(buf, vec![1, 0, 0, 0, 2, 0, 0, 0]);
    }

    #[test]
    fn writes_srational_le() {
        let mut buf = Vec::new();
        write_srational(&mut buf, -1, 2);
        // -1 as i32 little-endian = 0xFFFFFFFF
        assert_eq!(buf, vec![0xFF, 0xFF, 0xFF, 0xFF, 2, 0, 0, 0]);
    }

    #[test]
    fn ifd_with_two_short_entries_serialises_to_expected_bytes() {
        // Build IFD with two SHORT entries (each fits in the 4-byte value
        // slot, no overflow data). ImageWidth = 64, ImageLength = 64.
        // Layout (file_offset = 0 for this test):
        //   [u16 count=2]
        //   [tag=256, type=3 (SHORT), count=1, value=64 (in low 2 bytes)]
        //   [tag=257, type=3 (SHORT), count=1, value=64]
        //   [u32 next=0]
        // = 2 + 12 + 12 + 4 = 30 bytes
        let mut ifd = Ifd::new();
        ifd.add_short(256, 64);
        ifd.add_short(257, 64);
        let mut buf = Vec::new();
        ifd.serialise_into(&mut buf, /*file_offset_of_ifd*/ 0);
        assert_eq!(buf.len(), 30);
        // Count
        assert_eq!(&buf[0..2], &[2, 0]);
        // First entry: tag 256 (0x0100), type 3, count 1, value 64
        assert_eq!(&buf[2..4], &[0x00, 0x01]); // tag
        assert_eq!(&buf[4..6], &[3, 0]); // type = SHORT
        assert_eq!(&buf[6..10], &[1, 0, 0, 0]); // count = 1
        assert_eq!(&buf[10..14], &[64, 0, 0, 0]); // value = 64 (padded)
                                                  // Next-IFD offset = 0
        assert_eq!(&buf[26..30], &[0, 0, 0, 0]);
    }

    #[test]
    fn ifd_with_overflow_entry_emits_data_after_directory() {
        // ColorMatrix1 (tag 50721): 9 SRATIONAL = 72 bytes, overflows.
        // The IFD entry holds an offset; the data bytes follow.
        let mut ifd = Ifd::new();
        ifd.add_srationals(50721, vec![(1, 1); 9]);
        let mut buf = Vec::new();
        let file_offset = 100u32;
        ifd.serialise_into(&mut buf, file_offset);
        // 2 (count) + 12 (entry) + 4 (next) + 72 (overflow data) = 90 bytes
        assert_eq!(buf.len(), 90);
        // Entry's value slot is the absolute file offset of the overflow:
        // file_offset + 2 + 12 + 4 = 118.
        let expected_overflow_offset: u32 = file_offset + 2 + 12 + 4;
        assert_eq!(&buf[10..14], &expected_overflow_offset.to_le_bytes());
    }

    #[test]
    fn write_to_bytes_emits_tiff_magic() {
        let dng = SyntheticGreyDng::default();
        let bytes = dng.write_to_bytes();
        // TIFF II (little-endian) header: 0x49 0x49 0x2A 0x00
        assert_eq!(&bytes[0..4], &[0x49, 0x49, 0x2A, 0x00]);
        // IFD0 offset is at bytes 4..8, must be >= 8.
        let ifd0 = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        assert!(ifd0 >= 8, "IFD0 offset {} must be >= 8", ifd0);
    }

    #[test]
    fn write_to_bytes_pixel_buffer_size_matches_dimensions() {
        let dng = SyntheticGreyDng {
            width: 32,
            height: 32,
            ..Default::default()
        };
        let bytes = dng.write_to_bytes();
        // Pixel buffer = width * height * 2 bytes (16-bit). Total file
        // size must include header (8) + IFD + overflow + pixels.
        let pixel_bytes = 32 * 32 * 2;
        assert!(
            bytes.len() >= 8 + pixel_bytes,
            "file size {} too small for {} pixel bytes",
            bytes.len(),
            pixel_bytes
        );
    }

    #[test]
    fn round_trip_through_raw_core_decoder() {
        use crate::decode::decode_bytes;

        let dng = SyntheticGreyDng::default();
        let bytes = dng.write_to_bytes();

        let raw = decode_bytes(&bytes, "dng").expect("synthetic DNG must decode via raw-core");

        assert_eq!(raw.width, 64);
        assert_eq!(raw.height, 64);
        assert_eq!(raw.cfa, CfaPattern::Rggb);
        assert_eq!(raw.white_level, 65535);
        // black_level is per-CFA-position; all four should be 0 since we
        // wrote a single BlackLevel = 0.
        assert!(
            raw.black_level.iter().all(|&b| b == 0),
            "expected black_level all zero, got {:?}",
            raw.black_level
        );
        // AsShotNeutral round-trips (small float tolerance for rational div).
        assert!((raw.as_shot_neutral[0] - 0.5).abs() < 1e-3);
        assert!((raw.as_shot_neutral[1] - 1.0).abs() < 1e-3);
        assert!((raw.as_shot_neutral[2] - 0.5).abs() < 1e-3);
        // Raw pixel buffer length matches w * h.
        assert_eq!(raw.raw_data.len(), (64 * 64) as usize);
        // Spot-check one R, G, B sample. RGGB at (0,0)=R, (1,0)=G, (1,1)=B.
        assert_eq!(raw.raw_data[0], 5898); // (0,0) R
        assert_eq!(raw.raw_data[1], 11796); // (1,0) G
        assert_eq!(raw.raw_data[64 + 1], 5898); // (1,1) B
    }

    #[test]
    fn hasselblad_dcp_round_trips() {
        use crate::decode::decode_bytes;
        let dng = SyntheticGreyDng::default()
            .with_hasselblad_dcp()
            .with_simple_tone_curve();
        let bytes = dng.write_to_bytes();
        let raw = decode_bytes(&bytes, "dng").expect("Hasselblad-DCP synthetic must decode");

        // Two color matrices populated (StdA + D65).
        assert_eq!(
            raw.color_matrices.len(),
            2,
            "expected 2 illuminants, got {}",
            raw.color_matrices.len()
        );

        // AsShotNeutral picked up the Hasselblad override.
        let asn = raw.as_shot_neutral;
        assert!(
            (asn[0] - crate::test_support::hasselblad_dcp::AS_SHOT_NEUTRAL[0]).abs() < 1e-3,
            "as_shot_neutral[0] = {} (expected ~{})",
            asn[0],
            crate::test_support::hasselblad_dcp::AS_SHOT_NEUTRAL[0]
        );
        assert!((asn[1] - crate::test_support::hasselblad_dcp::AS_SHOT_NEUTRAL[1]).abs() < 1e-3);
        assert!((asn[2] - crate::test_support::hasselblad_dcp::AS_SHOT_NEUTRAL[2]).abs() < 1e-3);

        // ProfileToneCurve emitted by `with_simple_tone_curve()` round-trips.
        let curve = raw
            .profile_tone_curve
            .as_ref()
            .expect("ProfileToneCurve must round-trip when emitted");
        assert_eq!(
            curve.points.len(),
            5,
            "expected 5 control points, got {}",
            curve.points.len()
        );
    }

    /// Regression test for #418 — DNG `LinearizationTable` (tag 50712) is
    /// honored. The ticket originally asked us to apply the LUT inside
    /// `sensor_linearize`, but rawler 0.7.2 already applies it during decode
    /// (`rawler::decoders::mod::apply_linearization`, called at
    /// `decoders/mod.rs:641-642` in the Integer sample-format path). This
    /// test locks that behaviour in: we synthesise a DNG that writes the raw
    /// strip with encoded code `100` everywhere, ship a `LinearizationTable`
    /// where `table[i] = i * SCALE`, and assert the decoded `raw_data` reads
    /// `100 * SCALE` per CFA position (within rawler's dither tolerance).
    ///
    /// Without the rawler-side application, decoded values would still be
    /// `100` and the test would fail by a factor of `SCALE`.
    #[test]
    fn linearization_table_is_applied_during_decode() {
        use crate::decode::decode_bytes;

        // Monotone LUT: table[i] = i * SCALE. SCALE chosen large enough that
        // an un-applied LUT would be unmistakably wrong (decoded == encoded
        // instead of encoded * SCALE), and small enough that the LUT entries
        // stay inside u16.
        const SCALE: u16 = 4;
        const ENCODED: u16 = 100;
        // Table length: 256 entries is sufficient — rawler's
        // `LookupTable::new_with_bits(points, bits=16)` pads to `1 << 16`
        // by repeating the last entry, so any code ≥ table.len() maps to
        // `table[last]`. Our ENCODED=100 is well inside the table.
        let table: Vec<u16> = (0..256u32)
            .map(|i| (i as u16).saturating_mul(SCALE))
            .collect();

        let dng = SyntheticGreyDng {
            width: 8,
            height: 8,
            linearization_table: Some(table.clone()),
            encoded_value_override: Some(ENCODED),
            ..Default::default()
        };
        let bytes = dng.write_to_bytes();
        let raw =
            decode_bytes(&bytes, "dng").expect("synthetic DNG with LinearizationTable must decode");

        // Expected linearised value, plus rawler's dither tolerance.
        // `LookupTable::dither` does:
        //   base  = center − ((upper − lower + 2) / 4)
        //   delta = upper − lower
        //   pixel = base + (delta * (rand & 2047) + 1024) >> 12   ∈ [base, base+delta]
        // For a monotone table[i] = i * SCALE: center = ENCODED * SCALE,
        // upper − lower = 2 * SCALE, so pixel ∈ [center − SCALE/2 (round), center + 3*SCALE/2 (round)].
        // i.e. |pixel − center| ≤ 2 * SCALE. Use 2*SCALE as the tolerance.
        let expected = (ENCODED as u32) * (SCALE as u32);
        let tol = 2 * (SCALE as u32);

        assert_eq!(raw.raw_data.len(), (8 * 8) as usize);
        for (k, &v) in raw.raw_data.iter().enumerate() {
            let v = v as u32;
            assert!(
                v.abs_diff(expected) <= tol,
                "pixel {}: raw_data = {} not within ±{} of expected {} \
                 (LinearizationTable not applied by rawler decode?)",
                k,
                v,
                tol,
                expected
            );
        }

        // Bit-identical-when-absent contract: same DNG without the LUT
        // must come back unscaled.
        let dng_no_lut = SyntheticGreyDng {
            width: 8,
            height: 8,
            encoded_value_override: Some(ENCODED),
            ..Default::default()
        };
        let bytes_no_lut = dng_no_lut.write_to_bytes();
        let raw_no_lut = decode_bytes(&bytes_no_lut, "dng")
            .expect("synthetic DNG without LinearizationTable must decode");
        for (k, &v) in raw_no_lut.raw_data.iter().enumerate() {
            assert_eq!(
                v, ENCODED,
                "pixel {}: without LUT, raw_data must equal encoded code {}, got {}",
                k, ENCODED, v
            );
        }
    }
}

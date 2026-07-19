//! Large synthetic Bayer DNG for the native-detail 1:1-zoom perf bench
//! (#2114).
//!
//! The 100MP color reference `test_0000.DNG` (Hasselblad L3D-100c) carries an
//! `OpcodeList3` (GainMap / WarpRectilinear). The tile develop chain that the
//! Apple `NativeDetailRenderer` drives at 100% zoom refuses OpcodeList3 DNGs
//! (`pipeline::tile`, #1932) and a 1:1 zoom falls back to the whole-image
//! render — so the native-detail develop can't be profiled on the reference
//! RAW. This generator emits a same-scale (~100MP) DNG that carries NO
//! OpcodeList3, so the tile path actually runs and is measurable.
//!
//! It is deliberately a *perf* fixture, not a color fixture: the strip is a
//! deterministic textured pattern (low-frequency gradient + a Nyquist
//! checkerboard) so the demosaic and the per-pixel color pipeline both do
//! representative work across the whole frame, but the developed colors are
//! not asserted anywhere. The embedded matrices are the real Hasselblad
//! L3D-100c dual-illuminant CM1/CM2 + AsShotNeutral (from
//! [`crate::test_support::hasselblad_dcp`]) so the develop exercises the same
//! DCP-interpolation cost the reference camera's whole-image path does —
//! minus only the untileable OpcodeList3 step.
//!
//! The produced `.dng` is written under `test-fixtures/raws/` (gitignored, so
//! it is never committed); the committed artifact is this generator plus the
//! `gen-synthetic-dng` example that drives it. See the perf bench
//! `NativeDetailPerfTests` for how it is consumed.

use crate::image::CfaPattern;
use crate::test_support::hasselblad_dcp;
use crate::test_support::synth_dng::{
    matrix_to_srationals, vec3_to_rationals, write_u16_le, write_u32_le, Ifd,
};
use std::io;
use std::path::Path;

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
const TAG_COLOR_MATRIX_2: u16 = 50722;
const TAG_CAMERA_CALIBRATION_1: u16 = 50723;
const TAG_ANALOG_BALANCE: u16 = 50727;
const TAG_AS_SHOT_NEUTRAL: u16 = 50728;
const TAG_BASELINE_EXPOSURE: u16 = 50730;
const TAG_CALIBRATION_ILLUMINANT_1: u16 = 50778;
const TAG_CALIBRATION_ILLUMINANT_2: u16 = 50779;

const PHOTOMETRIC_CFA: u16 = 32803;

/// Default width matching the Hasselblad L3D-100c reference sensor
/// (`test_0000.DNG` is 12288×8192 = 100.7 MP).
pub const DEFAULT_WIDTH: u32 = 12288;
/// Default height matching the Hasselblad L3D-100c reference sensor.
pub const DEFAULT_HEIGHT: u32 = 8192;

/// A large textured Bayer DNG with the real Hasselblad dual-illuminant DCP
/// and NO OpcodeList3 — the fixture the native-detail 1:1-zoom perf bench
/// develops. See the module docs.
#[derive(Clone, Debug)]
pub struct SyntheticPerfDng {
    pub width: u32,
    pub height: u32,
    pub cfa: CfaPattern,
}

impl Default for SyntheticPerfDng {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            cfa: CfaPattern::Rggb,
        }
    }
}

impl SyntheticPerfDng {
    /// Write the DNG to `path`, STREAMING the ~200MB pixel strip row-by-row so
    /// peak memory stays at the header/IFD (a few hundred bytes) plus one row,
    /// never the whole strip. The strip offset is known before any pixel is
    /// written (the two-pass IFD probe below sizes the directory first), so no
    /// offset bookkeeping depends on holding the pixels in memory.
    pub fn write_to(&self, path: &Path) -> io::Result<()> {
        use std::io::{BufWriter, Write};
        let file = std::fs::File::create(path)?;
        let mut w = BufWriter::new(file);
        w.write_all(&self.header_and_ifd_bytes())?;
        // Stream one Bayer row at a time — the only large buffer alive is a
        // single `width * 2`-byte row, not `width * height * 2`.
        let mut row: Vec<u8> = Vec::with_capacity(self.width as usize * 2);
        for y in 0..self.height {
            row.clear();
            for x in 0..self.width {
                write_u16_le(&mut row, self.raw_at(x, y));
            }
            w.write_all(&row)?;
        }
        w.flush()
    }

    /// In-memory variant used by the unit tests (small instances only). Builds
    /// the full byte vector including the strip. Prefer [`Self::write_to`] for
    /// the ~100MP fixture, which streams the strip instead of buffering it.
    pub fn write_to_bytes(&self) -> Vec<u8> {
        let strip_byte_count = (self.width as usize) * (self.height as usize) * 2;
        let header_ifd = self.header_and_ifd_bytes();
        let mut buf: Vec<u8> = Vec::with_capacity(header_ifd.len() + strip_byte_count);
        buf.extend_from_slice(&header_ifd);
        buf.extend_from_slice(&self.build_strip());
        buf
    }

    /// Serialise just the TIFF header + IFD0 (no pixel strip). The strip
    /// follows immediately after these bytes at `header + ifd` — the same
    /// offset written into `TAG_STRIP_OFFSETS` below.
    fn header_and_ifd_bytes(&self) -> Vec<u8> {
        let header_size: u32 = 8;
        let ifd0_offset = header_size;

        // First pass: learn IFD size with a dummy strip offset.
        let probe_ifd = self.build_ifd0(0);
        let mut probe_buf = Vec::new();
        probe_ifd.serialise_into(&mut probe_buf, ifd0_offset);
        let ifd_size = probe_buf.len() as u32;
        let strip_offset = ifd0_offset + ifd_size;

        let real_ifd = self.build_ifd0(strip_offset);
        let mut buf: Vec<u8> = Vec::with_capacity((header_size + ifd_size) as usize);
        buf.extend_from_slice(b"II");
        write_u16_le(&mut buf, 0x002A);
        write_u32_le(&mut buf, ifd0_offset);
        real_ifd.serialise_into(&mut buf, ifd0_offset);
        buf
    }

    fn build_ifd0(&self, strip_offset: u32) -> Ifd {
        let strip_byte_count = (self.width) * (self.height) * 2;
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
        ifd.add_short(TAG_PLANAR_CONFIG, 1);
        ifd.add_shorts(TAG_CFA_REPEAT_PATTERN_DIM, vec![2, 2]);
        ifd.add_bytes(TAG_CFA_PATTERN, self.cfa_pattern_bytes());
        ifd.add_bytes(TAG_DNG_VERSION, vec![1, 4, 0, 0]);
        ifd.add_bytes(TAG_DNG_BACKWARD_VERSION, vec![1, 0, 0, 0]);
        // UCM must not collide with a bundled profile so the embedded CM path
        // fires (mirrors SyntheticColorChart's "Maple Synthetic Chart").
        ifd.add_ascii(TAG_UNIQUE_CAMERA_MODEL, "Maple Synthetic Perf");
        ifd.add_short(TAG_BLACK_LEVEL, 0);
        ifd.add_short(TAG_WHITE_LEVEL, 65535);

        // CameraCalibration1 = identity, AnalogBalance = 1s, BaselineExposure
        // = 0 — the neutral per-unit setup shared by the other synthetic DNGs.
        let identity = [[1.0f32, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        ifd.add_srationals(TAG_CAMERA_CALIBRATION_1, matrix_to_srationals(identity));
        ifd.add_rationals(TAG_ANALOG_BALANCE, vec![(1, 1), (1, 1), (1, 1)]);
        ifd.add_srationals(TAG_BASELINE_EXPOSURE, vec![(0, 1)]);

        // Real Hasselblad L3D-100c dual-illuminant DCP (StdA CM1 + D65 CM2),
        // so the develop pays the same DCP-interpolation cost as the reference
        // camera's whole-image path — minus only the untileable OpcodeList3.
        ifd.add_srationals(
            TAG_COLOR_MATRIX_1,
            matrix_to_srationals(hasselblad_dcp::COLOR_MATRIX_1),
        );
        ifd.add_short(
            TAG_CALIBRATION_ILLUMINANT_1,
            hasselblad_dcp::CALIBRATION_ILLUMINANT_1,
        );
        ifd.add_srationals(
            TAG_COLOR_MATRIX_2,
            matrix_to_srationals(hasselblad_dcp::COLOR_MATRIX_2),
        );
        ifd.add_short(
            TAG_CALIBRATION_ILLUMINANT_2,
            hasselblad_dcp::CALIBRATION_ILLUMINANT_2,
        );
        ifd.add_rationals(
            TAG_AS_SHOT_NEUTRAL,
            vec3_to_rationals(hasselblad_dcp::AS_SHOT_NEUTRAL),
        );

        // NOTE: no OpcodeList1/2/3 tags are ever emitted — that absence is the
        // whole point of this fixture (#2114).
        ifd
    }

    /// Deterministic textured Bayer strip: a low-frequency diagonal gradient
    /// (mid-tones, so no channel is pinned flat) plus a per-pixel Nyquist
    /// checkerboard so the demosaic has real high-frequency detail to resolve
    /// across the entire frame. Content is not meaningful — only the per-pixel
    /// develop cost is (see module docs).
    fn build_strip(&self) -> Vec<u8> {
        let w = self.width as usize;
        let h = self.height as usize;
        let mut buf = Vec::with_capacity(w * h * 2);
        for y in 0..self.height {
            for x in 0..self.width {
                write_u16_le(&mut buf, self.raw_at(x, y));
            }
        }
        buf
    }

    fn raw_at(&self, x: u32, y: u32) -> u16 {
        let gx = x as f32 / self.width.max(1) as f32;
        let gy = y as f32 / self.height.max(1) as f32;
        // Diagonal gradient across mid-tones (~0.12 → ~0.62).
        let base = 0.12 + 0.25 * (gx + gy);
        // Nyquist checkerboard: alternates every pixel, giving the demosaic
        // worst-case edge work everywhere rather than a flat interior.
        let hf = if (x ^ y) & 1 == 0 { 0.06 } else { -0.06 };
        ((base + hf).clamp(0.0, 1.0) * 65535.0).round() as u16
    }

    fn cfa_pattern_bytes(&self) -> Vec<u8> {
        match self.cfa {
            CfaPattern::Rggb => vec![0, 1, 1, 2],
            CfaPattern::Bggr => vec![2, 1, 1, 0],
            CfaPattern::Grbg => vec![1, 0, 2, 1],
            CfaPattern::Gbrg => vec![1, 2, 0, 1],
            CfaPattern::LinearRgb => {
                panic!("SyntheticPerfDng with CfaPattern::LinearRgb is unsupported")
            }
            CfaPattern::XTrans(_) => panic!(
                "SyntheticPerfDng with CfaPattern::XTrans is unsupported \
                 (the DNG-writer's CFAPattern tag is 2×2-only)"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::decode_bytes;

    /// A small instance decodes at the requested dims, is Bayer RGGB, and —
    /// the load-bearing invariant for #2114 — carries NO OpcodeList3, so the
    /// tile develop path accepts it.
    #[test]
    fn perf_dng_decodes_without_opcode_list3() {
        let dng = SyntheticPerfDng {
            width: 256,
            height: 192,
            cfa: CfaPattern::Rggb,
        };
        let raw = decode_bytes(&dng.write_to_bytes(), "dng").expect("perf DNG must decode");
        assert_eq!(raw.width, 256);
        assert_eq!(raw.height, 192);
        assert_eq!(raw.cfa, CfaPattern::Rggb);
        assert!(
            raw.opcode_list3.is_none(),
            "perf fixture must carry NO OpcodeList3 (that is the whole point of #2114)"
        );
        // Dual-illuminant Hasselblad matrices survive the round trip.
        assert_eq!(
            raw.color_matrices.len(),
            2,
            "expected StdA + D65 CMs, got {}",
            raw.color_matrices.len()
        );
    }

    /// The strip is genuinely textured (not a flat patch) so the demosaic and
    /// per-pixel color pipeline do representative work.
    #[test]
    fn perf_dng_strip_is_textured() {
        let dng = SyntheticPerfDng {
            width: 64,
            height: 64,
            cfa: CfaPattern::Rggb,
        };
        let raw = decode_bytes(&dng.write_to_bytes(), "dng").expect("perf DNG must decode");
        let first = raw.raw_data[0];
        assert!(
            raw.raw_data.iter().any(|&v| v != first),
            "perf strip must vary across pixels (textured), not be flat"
        );
    }

    /// The default instance is the ~100MP reference scale.
    #[test]
    fn default_is_100mp_scale() {
        let dng = SyntheticPerfDng::default();
        assert_eq!(dng.width, 12288);
        assert_eq!(dng.height, 8192);
        assert_eq!((dng.width as u64) * (dng.height as u64), 100_663_296);
    }
}

//! Macbeth-style 24-patch color-chart synthetic DNG. See spec
//! .archived-plans/specs/2026-04-29-grey-card-dcp-coverage-design.md.

use crate::image::{CfaPattern, Image};
use crate::test_support::colorchecker::COLORCHECKER_REC2020;
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
const TAG_CAMERA_CALIBRATION_1: u16 = 50723;
const TAG_ANALOG_BALANCE: u16 = 50727;
const TAG_AS_SHOT_NEUTRAL: u16 = 50728;
const TAG_BASELINE_EXPOSURE: u16 = 50730;
const TAG_CALIBRATION_ILLUMINANT_1: u16 = 50778;

const PHOTOMETRIC_CFA: u16 = 32803;
const CALIBRATION_ILLUMINANT_D65: u16 = 21;

#[derive(Clone, Debug)]
pub struct SyntheticColorChart {
    /// Per-patch scene-linear Rec.2020 RGB targets. Default = ColorChecker.
    pub patches: [[[f32; 3]; 6]; 4],
    /// Pixel size of each patch (default 32).
    pub patch_size: u32,
    /// Guard band between patches in pixels (default 8).
    pub guard: u32,
    pub cfa: CfaPattern,
    pub as_shot_neutral_override: Option<[f32; 3]>,
}

impl Default for SyntheticColorChart {
    fn default() -> Self {
        Self {
            patches: COLORCHECKER_REC2020,
            patch_size: 32,
            guard: 8,
            cfa: CfaPattern::Rggb,
            as_shot_neutral_override: None,
        }
    }
}

impl SyntheticColorChart {
    pub fn cols(&self) -> u32 {
        6
    }
    pub fn rows(&self) -> u32 {
        4
    }

    pub fn width(&self) -> u32 {
        self.cols() * (self.patch_size + self.guard) - self.guard
    }
    pub fn height(&self) -> u32 {
        self.rows() * (self.patch_size + self.guard) - self.guard
    }

    pub fn write_to(&self, path: &Path) -> io::Result<()> {
        std::fs::write(path, self.write_to_bytes())
    }

    pub fn write_to_bytes(&self) -> Vec<u8> {
        let header_size: u32 = 8;
        let ifd0_offset = header_size;
        let strip_byte_count = (self.width() as usize) * (self.height() as usize) * 2;

        let probe_ifd = self.build_ifd0(0);
        let mut probe_buf = Vec::new();
        probe_ifd.serialise_into(&mut probe_buf, ifd0_offset);
        let ifd_size = probe_buf.len() as u32;
        let strip_offset = ifd0_offset + ifd_size;

        let real_ifd = self.build_ifd0(strip_offset);
        let mut buf: Vec<u8> =
            Vec::with_capacity((header_size as usize) + (ifd_size as usize) + strip_byte_count);
        buf.extend_from_slice(b"II");
        write_u16_le(&mut buf, 0x002A);
        write_u32_le(&mut buf, ifd0_offset);
        real_ifd.serialise_into(&mut buf, ifd0_offset);
        buf.extend_from_slice(&self.build_strip());
        buf
    }

    fn build_ifd0(&self, strip_offset: u32) -> Ifd {
        let strip_byte_count = (self.width() as u32) * (self.height() as u32) * 2;
        let mut ifd = Ifd::new();
        ifd.add_long(TAG_NEW_SUBFILE_TYPE, 0);
        ifd.add_long(TAG_IMAGE_WIDTH, self.width());
        ifd.add_long(TAG_IMAGE_LENGTH, self.height());
        ifd.add_short(TAG_BITS_PER_SAMPLE, 16);
        ifd.add_short(TAG_COMPRESSION, 1);
        ifd.add_short(TAG_PHOTOMETRIC, PHOTOMETRIC_CFA);
        ifd.add_long(TAG_STRIP_OFFSETS, strip_offset);
        ifd.add_short(TAG_SAMPLES_PER_PIXEL, 1);
        ifd.add_long(TAG_ROWS_PER_STRIP, self.height());
        ifd.add_long(TAG_STRIP_BYTE_COUNTS, strip_byte_count);
        ifd.add_short(TAG_PLANAR_CONFIG, 1);
        ifd.add_shorts(TAG_CFA_REPEAT_PATTERN_DIM, vec![2, 2]);
        ifd.add_bytes(TAG_CFA_PATTERN, self.cfa_pattern_bytes());
        ifd.add_bytes(TAG_DNG_VERSION, vec![1, 4, 0, 0]);
        ifd.add_bytes(TAG_DNG_BACKWARD_VERSION, vec![1, 0, 0, 0]);
        ifd.add_ascii(TAG_UNIQUE_CAMERA_MODEL, "Maple Synthetic Chart");
        ifd.add_short(TAG_BLACK_LEVEL, 0);
        ifd.add_short(TAG_WHITE_LEVEL, 65535);

        // Identity ColorMatrix1 — chart starts simple.
        let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        ifd.add_srationals(TAG_COLOR_MATRIX_1, matrix_to_srationals(identity));
        ifd.add_srationals(TAG_CAMERA_CALIBRATION_1, matrix_to_srationals(identity));
        ifd.add_rationals(TAG_ANALOG_BALANCE, vec![(1, 1), (1, 1), (1, 1)]);
        let asn = self.as_shot_neutral_override.unwrap_or([1.0, 1.0, 1.0]);
        ifd.add_rationals(TAG_AS_SHOT_NEUTRAL, vec3_to_rationals(asn));
        ifd.add_srationals(TAG_BASELINE_EXPOSURE, vec![(0, 1)]);
        ifd.add_short(TAG_CALIBRATION_ILLUMINANT_1, CALIBRATION_ILLUMINANT_D65);
        let _ = strip_byte_count; // already consumed above; keep var alive for clarity
        ifd
    }

    /// Walk the chart row-major; for each pixel, look up which patch it
    /// belongs to, get that patch's target scene-linear color, and write
    /// the 16-bit raw value at the CFA position.
    fn build_strip(&self) -> Vec<u8> {
        let w = self.width() as usize;
        let h = self.height() as usize;
        let mut buf = Vec::with_capacity(w * h * 2);
        let asn = self.as_shot_neutral_override.unwrap_or([1.0, 1.0, 1.0]);
        for y in 0..h {
            for x in 0..w {
                let v = self.raw_at(x as u32, y as u32, asn);
                write_u16_le(&mut buf, v);
            }
        }
        buf
    }

    /// Synthesize per-CFA-position raw value. Post-WB scene-linear
    /// equals `target / asn` (raw 65535 normalises to 1.0, then WB
    /// multiplies by 1/asn). To get the target, raw = target * asn * 65535.
    fn raw_at(&self, x: u32, y: u32, asn: [f32; 3]) -> u16 {
        let (col, row) = self.patch_at(x, y);
        let target = self.patches[row as usize][col as usize];
        let chan = self.cfa.color_at(x, y) as usize;
        let target_per_channel = target[chan];
        let asn_per_channel = asn[chan];
        let raw_f = target_per_channel * asn_per_channel * 65535.0;
        raw_f.round().clamp(0.0, u16::MAX as f32) as u16
    }

    /// Map pixel (x, y) to (col, row). Pixels beyond the chart end up
    /// in the rightmost / bottom-most patch (clamped).
    fn patch_at(&self, x: u32, y: u32) -> (u32, u32) {
        let stride = self.patch_size + self.guard;
        let col = (x / stride).min(self.cols() - 1);
        let row = (y / stride).min(self.rows() - 1);
        (col, row)
    }

    fn cfa_pattern_bytes(&self) -> Vec<u8> {
        match self.cfa {
            CfaPattern::Rggb => vec![0, 1, 1, 2],
            CfaPattern::Bggr => vec![2, 1, 1, 0],
            CfaPattern::Grbg => vec![1, 0, 2, 1],
            CfaPattern::Gbrg => vec![1, 2, 0, 1],
            CfaPattern::LinearRgb => {
                panic!("SyntheticColorChart with CfaPattern::LinearRgb is unsupported")
            }
            CfaPattern::XTrans(_) => panic!(
                "SyntheticColorChart with CfaPattern::XTrans is unsupported \
                 (the DNG-writer's CFAPattern tag is 2×2-only)"
            ),
        }
    }

    /// Read patch `(col, row)` from a developed `Image`. Returns the
    /// per-channel mean over the patch's interior, skipping the outer
    /// 4 pixels on every side to absorb demosaic bleed.
    pub fn read_patch_mean(&self, image: &Image, col: usize, row: usize) -> [f32; 3] {
        let stride = (self.patch_size + self.guard) as usize;
        let x0 = col * stride + 4;
        let y0 = row * stride + 4;
        let inner = self.patch_size as usize - 8;
        let w = image.width as usize;
        let mut sums = [0.0_f64; 3];
        let mut n: u64 = 0;
        for dy in 0..inner {
            for dx in 0..inner {
                let i = (y0 + dy) * w + (x0 + dx);
                if i >= image.pixels.len() {
                    continue;
                }
                let p = image.pixels[i];
                sums[0] += p[0] as f64;
                sums[1] += p[1] as f64;
                sums[2] += p[2] as f64;
                n += 1;
            }
        }
        let nn = n.max(1) as f64;
        [
            (sums[0] / nn) as f32,
            (sums[1] / nn) as f32,
            (sums[2] / nn) as f32,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::decode_bytes;

    #[test]
    fn chart_round_trips_via_decoder() {
        let chart = SyntheticColorChart::default();
        let bytes = chart.write_to_bytes();
        let raw = decode_bytes(&bytes, "dng").expect("synthetic chart must decode");
        assert_eq!(raw.width, chart.width());
        assert_eq!(raw.height, chart.height());
        assert_eq!(raw.cfa, CfaPattern::Rggb);
    }
}

//! Synthetic LinearRaw DNG writer (`PhotometricInterpretation = 34892`,
//! three 16-bit samples per pixel, no CFA). Companion to
//! [`super::synth_dng::SyntheticGreyDng`] for the already-demosaiced decode
//! path, with an independent black level per channel so per-channel black
//! handling can be asserted end to end (#4730).

use super::synth_dng::{
    matrix_to_srationals, vec3_to_rationals, write_u16_le, write_u32_le, Ifd, TAG_AS_SHOT_NEUTRAL,
    TAG_BASELINE_EXPOSURE, TAG_BITS_PER_SAMPLE, TAG_BLACK_LEVEL, TAG_CALIBRATION_ILLUMINANT_1,
    TAG_COLOR_MATRIX_1, TAG_COMPRESSION, TAG_DNG_BACKWARD_VERSION, TAG_DNG_VERSION,
    TAG_IMAGE_LENGTH, TAG_IMAGE_WIDTH, TAG_NEW_SUBFILE_TYPE, TAG_PHOTOMETRIC, TAG_PLANAR_CONFIG,
    TAG_ROWS_PER_STRIP, TAG_SAMPLES_PER_PIXEL, TAG_STRIP_BYTE_COUNTS, TAG_STRIP_OFFSETS,
    TAG_UNIQUE_CAMERA_MODEL, TAG_WHITE_LEVEL,
};

const PHOTOMETRIC_LINEAR_RAW: u16 = 34892;
const CALIBRATION_ILLUMINANT_D65: u16 = 21;
const SAMPLES_PER_PIXEL: usize = 3;

/// Flat neutral LinearRaw frame: every pixel encodes `linear_value` as
/// `black[c] + linear_value × (white − black[c])` per channel, so a decoder
/// that honours each channel's own black level reads a neutral, and one that
/// does not shows a colour cast.
#[derive(Clone, Debug)]
pub struct SyntheticLinearRawDng {
    pub linear_value: f32,
    pub width: u32,
    pub height: u32,
    pub black_level: [u16; 3],
    pub white_level: u16,
}

impl Default for SyntheticLinearRawDng {
    fn default() -> Self {
        Self {
            linear_value: 0.18,
            width: 16,
            height: 16,
            black_level: [0, 0, 0],
            white_level: 65535,
        }
    }
}

impl SyntheticLinearRawDng {
    pub fn write_to_bytes(&self) -> Vec<u8> {
        let header_size: u32 = 8;
        let ifd0_offset = header_size;

        let probe_ifd = self.build_ifd0(0);
        let mut probe_buf = Vec::new();
        probe_ifd.serialise_into(&mut probe_buf, ifd0_offset);
        let strip_offset = ifd0_offset + probe_buf.len() as u32;

        let mut buf = Vec::new();
        buf.extend_from_slice(b"II");
        write_u16_le(&mut buf, 0x002A);
        write_u32_le(&mut buf, ifd0_offset);
        self.build_ifd0(strip_offset)
            .serialise_into(&mut buf, ifd0_offset);
        buf.extend_from_slice(&self.build_strip());
        buf
    }

    pub fn raw_rgb(&self) -> [u16; 3] {
        let encode = |black: u16| {
            let range = f32::from(self.white_level) - f32::from(black);
            (f32::from(black) + self.linear_value * range)
                .round()
                .clamp(0.0, f32::from(u16::MAX)) as u16
        };
        [
            encode(self.black_level[0]),
            encode(self.black_level[1]),
            encode(self.black_level[2]),
        ]
    }

    fn build_ifd0(&self, strip_offset: u32) -> Ifd {
        let strip_byte_count = self.width * self.height * SAMPLES_PER_PIXEL as u32 * 2;
        let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

        let mut ifd = Ifd::new();
        ifd.add_long(TAG_NEW_SUBFILE_TYPE, 0);
        ifd.add_long(TAG_IMAGE_WIDTH, self.width);
        ifd.add_long(TAG_IMAGE_LENGTH, self.height);
        ifd.add_shorts(TAG_BITS_PER_SAMPLE, vec![16; SAMPLES_PER_PIXEL]);
        ifd.add_short(TAG_COMPRESSION, 1);
        ifd.add_short(TAG_PHOTOMETRIC, PHOTOMETRIC_LINEAR_RAW);
        ifd.add_long(TAG_STRIP_OFFSETS, strip_offset);
        ifd.add_short(TAG_SAMPLES_PER_PIXEL, SAMPLES_PER_PIXEL as u16);
        ifd.add_long(TAG_ROWS_PER_STRIP, self.height);
        ifd.add_long(TAG_STRIP_BYTE_COUNTS, strip_byte_count);
        ifd.add_short(TAG_PLANAR_CONFIG, 1);
        ifd.add_bytes(TAG_DNG_VERSION, vec![1, 4, 0, 0]);
        ifd.add_bytes(TAG_DNG_BACKWARD_VERSION, vec![1, 0, 0, 0]);
        ifd.add_ascii(TAG_UNIQUE_CAMERA_MODEL, "Maple Synthetic LinearRaw");
        ifd.add_shorts(TAG_BLACK_LEVEL, self.black_level.to_vec());
        ifd.add_short(TAG_WHITE_LEVEL, self.white_level);
        ifd.add_srationals(TAG_COLOR_MATRIX_1, matrix_to_srationals(identity));
        ifd.add_rationals(TAG_AS_SHOT_NEUTRAL, vec3_to_rationals([1.0, 1.0, 1.0]));
        ifd.add_srationals(TAG_BASELINE_EXPOSURE, vec![(0, 1)]);
        ifd.add_short(TAG_CALIBRATION_ILLUMINANT_1, CALIBRATION_ILLUMINANT_D65);
        ifd
    }

    fn build_strip(&self) -> Vec<u8> {
        let rgb = self.raw_rgb();
        let pixel_count = (self.width * self.height) as usize;
        let mut buf = Vec::with_capacity(pixel_count * SAMPLES_PER_PIXEL * 2);
        for _ in 0..pixel_count {
            for &sample in &rgb {
                write_u16_le(&mut buf, sample);
            }
        }
        buf
    }
}

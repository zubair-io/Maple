//! Macbeth-style 24-patch color-chart synthetic DNG. See spec
//! .archived-plans/specs/2026-04-29-grey-card-dcp-coverage-design.md.

use crate::color::illuminant::Illuminant;
use crate::color::matrices::M_XYZ_D65_TO_REC2020;
use crate::image::{CfaPattern, Image};
use crate::math::Matrix3;
use crate::test_support::canon_dcp;
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
const TAG_COLOR_MATRIX_2: u16 = 50722;
const TAG_CAMERA_CALIBRATION_1: u16 = 50723;
const TAG_ANALOG_BALANCE: u16 = 50727;
const TAG_AS_SHOT_NEUTRAL: u16 = 50728;
const TAG_BASELINE_EXPOSURE: u16 = 50730;
const TAG_CALIBRATION_ILLUMINANT_1: u16 = 50778;
const TAG_CALIBRATION_ILLUMINANT_2: u16 = 50779;
const TAG_FORWARD_MATRIX_1: u16 = 50964;
const TAG_FORWARD_MATRIX_2: u16 = 50965;

const PHOTOMETRIC_CFA: u16 = 32803;

/// How the chart's Bayer raw values are encoded.
///
/// `Rec2020` (default, used for test_0018): camera space IS scene-linear
/// Rec.2020. `ColorMatrix1 = M_XYZ_D65_TO_REC2020` declares that correctly
/// so both ACR and Maple treat the stored values as Rec.2020 coordinates.
/// `AsShotNeutral = [1, 1, 1]` — no white-balance shift needed.
///
/// `Camera` (used for test_0019): the same 24 Rec.2020 patch targets are
/// re-encoded through the Canon EOS 5D Mark IV dual-illuminant DCP model.
/// Raw Bayer values are computed by inverting the DCP transform at the
/// chart's AsShotNeutral, so the full `raw → demosaic → WB → DCP → Rec.2020`
/// pipeline must round-trip back to the original targets.  The DNG carries
/// the Canon CM1/CM2, FM1/FM2, and CalibrationIlluminant1/2 with a UCM of
/// `"Maple Synthetic Chart DCP"` — distinct from `"Canon EOS 5D Mark IV"` so
/// the bundled-profile lookup misses and the embedded matrices are used via
/// the `EmbeddedCmOnly` path.
#[derive(Clone, Debug, Default)]
pub enum ChartEncoding {
    /// Rec.2020-encoded chart (test_0018). Camera space = scene-linear
    /// Rec.2020; `ColorMatrix1 = M_XYZ_D65_TO_REC2020`, `AsShotNeutral =
    /// [1, 1, 1]`.
    #[default]
    Rec2020,
    /// Camera-encoded chart (test_0019). Raw values synthesised through the
    /// Canon EOS 5D Mark IV dual-illuminant DCP model; embedded CM1/CM2 and
    /// FM1/FM2 are the Canon matrices from the bundled profile.
    Camera,
}

#[derive(Clone, Debug)]
pub struct SyntheticColorChart {
    /// Per-patch scene-linear Rec.2020 RGB targets. Default = ColorChecker.
    pub patches: [[[f32; 3]; 6]; 4],
    /// Pixel size of each patch (default 32).
    pub patch_size: u32,
    /// Guard band between patches in pixels (default 8).
    pub guard: u32,
    pub cfa: CfaPattern,
    /// Raw-value encoding mode (default Rec2020).
    pub encoding: ChartEncoding,
}

impl Default for SyntheticColorChart {
    fn default() -> Self {
        Self {
            patches: COLORCHECKER_REC2020,
            patch_size: 32,
            guard: 8,
            cfa: CfaPattern::Rggb,
            encoding: ChartEncoding::Rec2020,
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
        ifd.add_short(TAG_BLACK_LEVEL, 0);
        ifd.add_short(TAG_WHITE_LEVEL, 65535);

        // CameraCalibration1 = identity always.
        let identity = [[1.0f32, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        ifd.add_srationals(TAG_CAMERA_CALIBRATION_1, matrix_to_srationals(identity));
        ifd.add_rationals(TAG_ANALOG_BALANCE, vec![(1, 1), (1, 1), (1, 1)]);
        ifd.add_srationals(TAG_BASELINE_EXPOSURE, vec![(0, 1)]);

        match self.encoding {
            ChartEncoding::Rec2020 => self.build_ifd0_rec2020(&mut ifd),
            ChartEncoding::Camera => self.build_ifd0_camera(&mut ifd),
        }

        let _ = strip_byte_count; // already consumed above
        ifd
    }

    /// Rec.2020 encoding: camera space IS scene-linear Rec.2020.
    ///
    /// `ColorMatrix1 = M_XYZ_D65_TO_REC2020` with `CalibrationIlluminant1 =
    /// D65` declares camera space = Rec.2020 under the DNG spec (CM maps
    /// XYZ → camera, so identity would mean camera = XYZ which is wrong).
    /// `AsShotNeutral = [1, 1, 1]` — pure equal-energy neutral, no WB shift.
    ///
    /// With this CM, `inv(CM) = M_REC2020_TO_XYZ_D65`, which the DCP path
    /// will compose with Bradford D65→D50 and then `inv(M_PRO_TO_XYZ_D50)`
    /// to arrive at ProPhoto, then `m_pro_to_rec2020()` back to Rec.2020 —
    /// the round-trip identity guarantees patches develop at their target
    /// values (up to the baseline exposure gain from the DCP path).
    fn build_ifd0_rec2020(&self, ifd: &mut Ifd) {
        // UCM must not collide with any bundled profile so the EmbeddedCmOnly
        // path fires. "Maple Synthetic Chart" has no bundle entry.
        ifd.add_ascii(TAG_UNIQUE_CAMERA_MODEL, "Maple Synthetic Chart");

        // CM1 = M_XYZ_D65_TO_REC2020 (XYZ D65 → camera, camera = Rec.2020).
        let cm1: [[f32; 3]; 3] = M_XYZ_D65_TO_REC2020.0;
        ifd.add_srationals(TAG_COLOR_MATRIX_1, matrix_to_srationals(cm1));
        // CalibrationIlluminant1 = D65 (21).
        ifd.add_short(TAG_CALIBRATION_ILLUMINANT_1, 21);
        // AsShotNeutral = [1, 1, 1] — equal-energy neutral.
        ifd.add_rationals(TAG_AS_SHOT_NEUTRAL, vec3_to_rationals([1.0, 1.0, 1.0]));
    }

    /// Camera encoding: raw values synthesised through Canon EOS 5D Mark IV
    /// dual-illuminant DCP model (CM1 StdA + CM2 D65, FM1 StdA + FM2 D65).
    ///
    /// UCM = "Maple Synthetic Chart DCP" — does NOT match the bundled entry
    /// "Canon EOS 5D Mark IV", so the resolve falls through to `EmbeddedCmOnly`
    /// using the embedded Canon matrices we write here.  The real Canon CMn/FMn
    /// matrices are embedded verbatim so Maple's DCP path can recover them.
    fn build_ifd0_camera(&self, ifd: &mut Ifd) {
        ifd.add_ascii(TAG_UNIQUE_CAMERA_MODEL, "Maple Synthetic Chart DCP");

        ifd.add_srationals(
            TAG_COLOR_MATRIX_1,
            matrix_to_srationals(canon_dcp::COLOR_MATRIX_1),
        );
        ifd.add_short(
            TAG_CALIBRATION_ILLUMINANT_1,
            canon_dcp::CALIBRATION_ILLUMINANT_1,
        );
        ifd.add_srationals(
            TAG_COLOR_MATRIX_2,
            matrix_to_srationals(canon_dcp::COLOR_MATRIX_2),
        );
        ifd.add_short(
            TAG_CALIBRATION_ILLUMINANT_2,
            canon_dcp::CALIBRATION_ILLUMINANT_2,
        );
        ifd.add_srationals(
            TAG_FORWARD_MATRIX_1,
            matrix_to_srationals(canon_dcp::FORWARD_MATRIX_1),
        );
        ifd.add_srationals(
            TAG_FORWARD_MATRIX_2,
            matrix_to_srationals(canon_dcp::FORWARD_MATRIX_2),
        );
        ifd.add_rationals(
            TAG_AS_SHOT_NEUTRAL,
            vec3_to_rationals(canon_dcp::AS_SHOT_NEUTRAL),
        );
    }

    /// Walk the chart row-major; for each pixel, look up which patch it
    /// belongs to, get that patch's target scene-linear color, and write
    /// the 16-bit raw value at the CFA position.
    fn build_strip(&self) -> Vec<u8> {
        let w = self.width() as usize;
        let h = self.height() as usize;
        let mut buf = Vec::with_capacity(w * h * 2);
        for y in 0..h {
            for x in 0..w {
                let v = self.raw_at(x as u32, y as u32);
                write_u16_le(&mut buf, v);
            }
        }
        buf
    }

    /// Synthesize per-CFA-position raw value for the given encoding.
    fn raw_at(&self, x: u32, y: u32) -> u16 {
        let (col, row) = self.patch_at(x, y);
        let target_rec2020 = self.patches[row as usize][col as usize];
        let chan = self.cfa.color_at(x, y) as usize;

        match self.encoding {
            ChartEncoding::Rec2020 => {
                // Camera space = Rec.2020, AsShotNeutral = [1,1,1].
                // raw = target_channel * 65535 (no WB scaling needed since ASN=1).
                let raw_f = target_rec2020[chan] * 65535.0;
                raw_f.round().clamp(0.0, u16::MAX as f32) as u16
            }
            ChartEncoding::Camera => {
                // Invert the full DCP transform to get camera raw values.
                // The forward path is:
                //   raw_camera / AsShotNeutral  →  wb_camera
                //   FM_interp × wb_camera       →  xyz_d50
                //   inv(M_PRO_TO_XYZ_D50) × xyz_d50  →  prophoto
                //   m_pro_to_rec2020() × prophoto  →  rec2020_out
                //
                // Inverting:
                //   target_rec2020  →  prophoto = inv(m_pro_to_rec2020()) × target
                //   →  xyz_d50 = M_PRO_TO_XYZ_D50 × prophoto
                //   →  wb_camera = inv(FM_interp) × xyz_d50
                //   →  raw_camera = wb_camera * AsShotNeutral  (element-wise)
                //   →  raw_u16 = clamp(raw_camera_ch * 65535, 0, 65535)
                //
                // FM_interp is the reciprocal-CCT-interpolated FM at the
                // AsShotNeutral CCT. We compute the inverse transform once per
                // pixel here — the chart is small (≤ ~6k pixels) so the cost
                // is negligible. Caching per-patch would be an over-engineering.
                let raw_f = camera_raw_from_rec2020(target_rec2020, chan);
                raw_f.round().clamp(0.0, u16::MAX as f32) as u16
            }
        }
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

// ── Camera-encoding inverse-DCP math ─────────────────────────────────────────

/// Invert the Canon DCP forward transform for `target_rec2020`, returning the
/// three white-balanced camera raw values (before AsShotNeutral scaling).
///
/// Forward chain (what Maple's pipeline does):
///   raw_camera[ch] / AsShotNeutral[ch]  →  wb_camera[ch]
///   FM_interp × wb_camera               →  xyz_d50
///   inv(M_PRO_TO_XYZ_D50) × xyz_d50    →  prophoto
///   m_pro_to_rec2020() × prophoto       →  rec2020_out
///
/// Inverse:
///   rec2020_target                       →  inv(m_pro_to_rec2020()) × target
///   →  prophoto
///   M_PRO_TO_XYZ_D50 × prophoto         →  xyz_d50
///   inv(FM_interp) × xyz_d50            →  wb_camera
///
/// Highly saturated patches (e.g. orange, red) that have very low values in
/// one channel may produce a negative `wb_camera` component — that channel
/// would clip to 0 in the DNG and cannot be round-tripped.  Callers should
/// use `camera_patch_unclipped` to skip such patches in round-trip assertions.
fn camera_wb_from_rec2020(target_rec2020: [f32; 3]) -> [f32; 3] {
    use crate::color::matrices::M_PRO_TO_XYZ_D50;

    let asn = canon_dcp::AS_SHOT_NEUTRAL;
    let fm_interp = interpolated_canon_fm(asn);

    let m_pro_to_rec2020 = crate::color::matrices::m_pro_to_rec2020();
    let inv_pro_to_rec2020 = m_pro_to_rec2020
        .inverse()
        .expect("m_pro_to_rec2020 is invertible");
    let prophoto = inv_pro_to_rec2020.mul_vec(target_rec2020);
    let xyz_d50 = M_PRO_TO_XYZ_D50.mul_vec(prophoto);
    let inv_fm = fm_interp
        .inverse()
        .expect("interpolated FM must be invertible");
    inv_fm.mul_vec(xyz_d50)
}

/// Returns `true` if all three camera raw channels for `target` are non-negative
/// (no channel clips to 0 in the DNG).  Patches that would clip cannot be
/// round-tripped and should be excluded from `camera_chart_round_trips_to_rec2020_targets`.
pub fn camera_patch_unclipped(target: [f32; 3]) -> bool {
    let wb = camera_wb_from_rec2020(target);
    wb[0] >= 0.0 && wb[1] >= 0.0 && wb[2] >= 0.0
}

/// Compute the 16-bit raw value for channel `chan` from `target_rec2020`.
fn camera_raw_from_rec2020(target_rec2020: [f32; 3], chan: usize) -> f32 {
    let asn = canon_dcp::AS_SHOT_NEUTRAL;
    let wb_camera = camera_wb_from_rec2020(target_rec2020);
    // raw_camera[ch] = wb_camera[ch] × AsShotNeutral[ch], scaled to 16-bit.
    wb_camera[chan] * asn[chan] * 65535.0
}

/// Compute the reciprocal-CCT interpolated ForwardMatrix for the Canon
/// EOS 5D Mark IV at the given AsShotNeutral, using the same algorithm
/// as `dcp::interpolated_profile`.
fn interpolated_canon_fm(asn: [f32; 3]) -> Matrix3 {
    let cm1 = Matrix3(canon_dcp::COLOR_MATRIX_1);
    let cm2 = Matrix3(canon_dcp::COLOR_MATRIX_2);
    let fm1 = Matrix3(canon_dcp::FORWARD_MATRIX_1);
    let fm2 = Matrix3(canon_dcp::FORWARD_MATRIX_2);

    let cct1 = Illuminant::StdA.cct(); // ~2856 K
    let cct2 = Illuminant::D65.cct(); // ~6504 K

    // Reciprocal-CCT interpolation parameter t from AsShotNeutral CCT.
    let as_shot_cct = compute_as_shot_cct_canon(asn, cm1, cct1, cm2, cct2);
    let inv_t1 = 1.0 / cct1;
    let inv_t2 = 1.0 / cct2;
    let inv_target = 1.0 / as_shot_cct;
    let t = ((inv_target - inv_t1) / (inv_t2 - inv_t1)).clamp(0.0, 1.0);

    // Lerp FM element-wise.
    Matrix3(std::array::from_fn(|i| {
        std::array::from_fn(|j| (1.0 - t) * fm1.0[i][j] + t * fm2.0[i][j])
    }))
}

/// McCamy CCT estimate from XYZ chromaticities.  Mirrors `dcp.rs`'s
/// `compute_as_shot_cct` — duplicated here to avoid an intra-crate
/// visibility issue.  The math is identical; any fix there must be
/// propagated here too.
fn compute_as_shot_cct_canon(
    wb_neutral: [f32; 3],
    m_cold: Matrix3,
    cct_cold: f32,
    m_warm: Matrix3,
    cct_warm: f32,
) -> f32 {
    let mut cct = (cct_cold + cct_warm) * 0.5;
    let mut prev = 0.0_f32;
    for _ in 0..15 {
        if (cct - prev).abs() < 1.0 {
            break;
        }
        prev = cct;
        // Interpolate CM at current CCT estimate.
        let inv_t1 = 1.0 / cct_cold;
        let inv_t2 = 1.0 / cct_warm;
        let inv_target = 1.0 / cct;
        let t = ((inv_target - inv_t1) / (inv_t2 - inv_t1)).clamp(0.0, 1.0);
        let cm = Matrix3(std::array::from_fn(|i| {
            std::array::from_fn(|j| (1.0 - t) * m_cold.0[i][j] + t * m_warm.0[i][j])
        }));
        let cm_inv = match cm.inverse() {
            Some(inv) => inv,
            None => break,
        };
        let xyz = cm_inv.mul_vec(wb_neutral);
        let sum = xyz[0] + xyz[1] + xyz[2];
        if sum < 1e-6 {
            break;
        }
        let x = xyz[0] / sum;
        let y = xyz[1] / sum;
        let n = (x - 0.3320) / (0.1858 - y);
        cct = (437.0 * n.powi(3) + 3601.0 * n.powi(2) + 6861.0 * n + 5517.0)
            .clamp(2000.0, 15000.0);
    }
    cct
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

    /// The corrected Rec.2020 chart embeds a non-identity ColorMatrix1
    /// (M_XYZ_D65_TO_REC2020). Verify it round-trips through the decoder
    /// and is NOT filtered as identity.
    #[test]
    fn rec2020_chart_has_non_identity_embedded_cm() {
        use crate::color::illuminant::Illuminant;
        let chart = SyntheticColorChart::default();
        let bytes = chart.write_to_bytes();
        let raw = decode_bytes(&bytes, "dng").expect("must decode");
        // color_matrices must not be empty — that would mean the CM was
        // rejected as identity.
        assert!(
            !raw.color_matrices.is_empty(),
            "Rec.2020 chart embedded CM was rejected as identity (color_matrices is empty)"
        );
        // Specifically the D65 illuminant entry must be present.
        assert!(
            raw.color_matrices.contains_key(&Illuminant::D65),
            "Rec.2020 chart must have D65 ColorMatrix in decoded color_matrices"
        );
    }

    /// The camera-encoded chart embeds the Canon dual-illuminant matrices.
    /// Verify they decode correctly (both StdA and D65 illuminants present,
    /// non-identity CMs).
    #[test]
    fn camera_chart_has_dual_illuminant_cms() {
        use crate::color::illuminant::Illuminant;
        let chart = SyntheticColorChart {
            encoding: ChartEncoding::Camera,
            ..Default::default()
        };
        let bytes = chart.write_to_bytes();
        let raw = decode_bytes(&bytes, "dng").expect("must decode");
        assert_eq!(
            raw.color_matrices.len(),
            2,
            "camera chart must have two illuminant CMs (StdA + D65), got {}",
            raw.color_matrices.len()
        );
        assert!(
            raw.color_matrices.contains_key(&Illuminant::StdA),
            "camera chart must have StdA CM"
        );
        assert!(
            raw.color_matrices.contains_key(&Illuminant::D65),
            "camera chart must have D65 CM"
        );
    }
}


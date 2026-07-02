//! Dense ACR sweep chart generator (Phase 2, #1719).
//!
//! `SyntheticSweepChart` emits a 3584×2688 Bayer DNG with 3072 patches:
//! - rows  0–1  (128): neutral luminance ramp, log-spaced L ∈ [0.001, 4.0].
//! - rows  2–43 (2688): SDR color sweep (24 hues × 8 chromas × 14 lumas),
//!   generated in Oklab, converted to linear Rec.2020.
//! - rows 44–47 (256): exposure planes — 128 sweep patches at 2× and 4×.
//!
//! Spec: .archived-plans/specs/2026-07-02-acr-color-calibration-design.md

use crate::color::matrices::M_XYZ_D65_TO_REC2020;
use crate::color::oklab::{oklab_to_srgb_linear, srgb_linear_to_oklab};
use crate::test_support::synth_dng::{
    matrix_to_srationals, vec3_to_rationals, write_u16_le, write_u32_le, Ifd,
};
use std::io;
use std::path::Path;

// DNG tag IDs (same values as synth_chart.rs / synth_dng.rs).
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

// Grid geometry.
pub const COLS: u32 = 64;
pub const ROWS: u32 = 48;
pub const PATCH_SIZE: u32 = 48;
pub const GUARD: u32 = 8;
pub const N_PATCHES: usize = (COLS * ROWS) as usize;

// Row boundaries.
pub const NEUTRAL_ROWS: u32 = 2;
pub const SWEEP_ROWS: u32 = 42;
pub const EXPOSURE_ROWS: u32 = 4;

// Sweep dimensions: 24 hues × 8 chromas × 14 lumas = 2688 patches.
const HUE_STEPS: usize = 24;
const CHROMA_STEPS: usize = 8;
const LUMA_STEPS: usize = 14;
const N_SWEEP: usize = (COLS * SWEEP_ROWS) as usize;

// Exposure-plane subset: stride-21 from sweep ≈ 128 patches.
const EXPOSURE_SUBSET_STRIDE: usize = 21;
const EXPOSURE_SUBSET_N: usize = 128;

/// Population group for a patch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatchGroup {
    Neutral,
    Sweep,
    Exposure2x,
    Exposure4x,
}

impl PatchGroup {
    pub fn as_str(self) -> &'static str {
        match self {
            PatchGroup::Neutral => "neutral",
            PatchGroup::Sweep => "sweep",
            PatchGroup::Exposure2x => "exposure2x",
            PatchGroup::Exposure4x => "exposure4x",
        }
    }
}

/// Specification for one patch in the sweep chart.
#[derive(Clone, Debug)]
pub struct PatchSpec {
    pub index: usize,
    pub col: u32,
    pub row: u32,
    /// Scene-linear Rec.2020 [R, G, B] target.
    pub target_rec2020: [f32; 3],
    pub group: PatchGroup,
    /// True if any channel was negative before clamping.
    pub clamped: bool,
}

impl PatchSpec {
    /// Serialise to a compact single-line JSON object.
    pub fn to_json_line(&self) -> String {
        format!(
            "{{\"index\":{},\"col\":{},\"row\":{},\
             \"target_rec2020\":[{:.6},{:.6},{:.6}],\
             \"group\":\"{}\",\"clamped\":{}}}",
            self.index,
            self.col,
            self.row,
            self.target_rec2020[0],
            self.target_rec2020[1],
            self.target_rec2020[2],
            self.group.as_str(),
            self.clamped,
        )
    }
}

/// Dense 3072-patch sweep chart for ACR calibration (Phase 2, #1719).
pub struct SyntheticSweepChart {
    specs: Vec<PatchSpec>,
}

impl Default for SyntheticSweepChart {
    fn default() -> Self {
        Self::new()
    }
}

impl SyntheticSweepChart {
    pub fn new() -> Self {
        Self {
            specs: build_patch_specs(),
        }
    }

    /// Width = `COLS × (PATCH_SIZE + GUARD)` = 3584.
    pub fn width(&self) -> u32 {
        COLS * (PATCH_SIZE + GUARD)
    }

    /// Height = `ROWS × (PATCH_SIZE + GUARD)` = 2688.
    pub fn height(&self) -> u32 {
        ROWS * (PATCH_SIZE + GUARD)
    }

    pub fn specs(&self) -> &[PatchSpec] {
        &self.specs
    }

    pub fn spec_at(&self, col: u32, row: u32) -> &PatchSpec {
        &self.specs[(row * COLS + col) as usize]
    }

    pub fn write_to(&self, path: &Path) -> io::Result<()> {
        std::fs::write(path, self.write_to_bytes())
    }

    /// Serialise all specs as a JSON array (one object per line).
    pub fn spec_to_json(&self) -> String {
        let mut out = String::with_capacity(self.specs.len() * 120);
        out.push('[');
        for (i, s) in self.specs.iter().enumerate() {
            out.push('\n');
            out.push_str(&s.to_json_line());
            if i + 1 < self.specs.len() {
                out.push(',');
            }
        }
        out.push_str("\n]");
        out
    }

    pub fn write_to_bytes(&self) -> Vec<u8> {
        let header_size: u32 = 8;
        let ifd0_offset = header_size;
        let strip_bytes = (self.width() as usize) * (self.height() as usize) * 2;
        let probe_ifd = self.build_ifd0(0);
        let mut probe_buf = Vec::new();
        probe_ifd.serialise_into(&mut probe_buf, ifd0_offset);
        let ifd_size = probe_buf.len() as u32;
        let strip_offset = ifd0_offset + ifd_size;
        let real_ifd = self.build_ifd0(strip_offset);
        let mut buf =
            Vec::with_capacity((header_size as usize) + (ifd_size as usize) + strip_bytes);
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
        ifd.add_bytes(TAG_CFA_PATTERN, vec![0, 1, 1, 2]); // RGGB
        ifd.add_bytes(TAG_DNG_VERSION, vec![1, 4, 0, 0]);
        ifd.add_bytes(TAG_DNG_BACKWARD_VERSION, vec![1, 0, 0, 0]);
        ifd.add_ascii(TAG_UNIQUE_CAMERA_MODEL, "Maple Synthetic Sweep Chart");
        ifd.add_short(TAG_BLACK_LEVEL, 0);
        ifd.add_short(TAG_WHITE_LEVEL, 65535);
        ifd.add_srationals(
            TAG_CAMERA_CALIBRATION_1,
            matrix_to_srationals([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
        );
        ifd.add_rationals(TAG_ANALOG_BALANCE, vec![(1, 1), (1, 1), (1, 1)]);
        // CM1 = M_XYZ_D65_TO_REC2020: camera space = linear Rec.2020.
        ifd.add_srationals(
            TAG_COLOR_MATRIX_1,
            matrix_to_srationals(M_XYZ_D65_TO_REC2020.0),
        );
        ifd.add_short(TAG_CALIBRATION_ILLUMINANT_1, 21); // D65
                                                         // AsShotNeutral = [1,1,1]: no WB shift.
        ifd.add_rationals(TAG_AS_SHOT_NEUTRAL, vec3_to_rationals([1.0, 1.0, 1.0]));
        ifd.add_srationals(TAG_BASELINE_EXPOSURE, vec![(0, 1)]);
        let _ = strip_byte_count;
        ifd
    }

    fn build_strip(&self) -> Vec<u8> {
        let w = self.width() as usize;
        let h = self.height() as usize;
        let stride = (PATCH_SIZE + GUARD) as usize;
        let mut buf = Vec::with_capacity(w * h * 2);
        for y in 0..h {
            for x in 0..w {
                let col = ((x / stride) as u32).min(COLS - 1);
                let row = ((y / stride) as u32).min(ROWS - 1);
                let spec = self.spec_at(col, row);
                let chan = cfa_rggb(x as u32, y as u32);
                let v = (spec.target_rec2020[chan] * 65535.0)
                    .round()
                    .clamp(0.0, 65535.0) as u16;
                write_u16_le(&mut buf, v);
            }
        }
        buf
    }
}

// RGGB CFA channel at pixel (x,y): 0=R, 1=G, 2=B.
fn cfa_rggb(x: u32, y: u32) -> usize {
    match ((y % 2) * 2 + (x % 2)) as usize {
        0 => 0,
        1 | 2 => 1,
        _ => 2,
    }
}

// Scene-linear luminance for the neutral ramp at flat_idx ∈ [0,127].
// Log-spaced from 0.001 to 4.0.
fn neutral_ramp_lum(flat_idx: usize) -> f32 {
    let t = flat_idx as f32 / 127.0;
    let lo = 0.001f32.log2();
    let hi = 4.0f32.log2();
    (lo + t * (hi - lo)).exp2()
}

struct SweepData {
    targets: Vec<[f32; 3]>,
    clamped_flags: Vec<bool>,
}

fn sweep_data() -> &'static SweepData {
    static ONCE: std::sync::OnceLock<SweepData> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        use crate::color::matrices::M_REC2020_TO_SRGB;
        let m_srgb_to_rec2020 = M_REC2020_TO_SRGB.inverse().expect("invertible");
        let mut targets = Vec::with_capacity(N_SWEEP);
        let mut clamped_flags = Vec::with_capacity(N_SWEEP);
        for flat_idx in 0..N_SWEEP {
            let hue_idx = flat_idx % HUE_STEPS;
            let rem = flat_idx / HUE_STEPS;
            let chroma_idx = rem % CHROMA_STEPS;
            let luma_idx = rem / CHROMA_STEPS;
            let okl = 0.15 + (luma_idx as f32) / (LUMA_STEPS - 1) as f32 * 0.80;
            let hue_rad = (hue_idx as f32) / (HUE_STEPS as f32) * std::f32::consts::TAU;
            let chroma_raw = 0.02 + (chroma_idx as f32) / (CHROMA_STEPS - 1) as f32 * 0.26;
            let c = chroma_raw.min((0.40 * okl).min(0.30));
            let srgb = oklab_to_srgb_linear([okl, c * hue_rad.cos(), c * hue_rad.sin()]);
            let has_neg1 = srgb[0] < 0.0 || srgb[1] < 0.0 || srgb[2] < 0.0;
            let srgb_c = [srgb[0].max(0.0), srgb[1].max(0.0), srgb[2].max(0.0)];
            let rec = m_srgb_to_rec2020.mul_vec(srgb_c);
            let has_neg2 = rec[0] < 0.0 || rec[1] < 0.0 || rec[2] < 0.0;
            targets.push([rec[0].max(0.0), rec[1].max(0.0), rec[2].max(0.0)]);
            clamped_flags.push(has_neg1 || has_neg2);
        }
        SweepData {
            targets,
            clamped_flags,
        }
    })
}

fn build_patch_specs() -> Vec<PatchSpec> {
    let sweep_tgt = &sweep_data().targets;
    let exposure_subset: Vec<[f32; 3]> = sweep_tgt
        .iter()
        .step_by(EXPOSURE_SUBSET_STRIDE)
        .take(EXPOSURE_SUBSET_N)
        .cloned()
        .collect();
    let exp_clamp: Vec<bool> = sweep_data()
        .clamped_flags
        .iter()
        .step_by(EXPOSURE_SUBSET_STRIDE)
        .take(EXPOSURE_SUBSET_N)
        .cloned()
        .collect();

    let mut specs = Vec::with_capacity(N_PATCHES);
    for row in 0..ROWS {
        for col in 0..COLS {
            let index = (row * COLS + col) as usize;
            let ri = row as usize;
            let ci = col as usize;
            let (group, rgb, clamped) = if row < NEUTRAL_ROWS {
                let lum = neutral_ramp_lum(ri * 64 + ci);
                (PatchGroup::Neutral, [lum, lum, lum], false)
            } else if row < NEUTRAL_ROWS + SWEEP_ROWS {
                let fi = (ri - NEUTRAL_ROWS as usize) * 64 + ci;
                (
                    PatchGroup::Sweep,
                    sweep_tgt[fi],
                    sweep_data().clamped_flags[fi],
                )
            } else {
                let er = ri - (NEUTRAL_ROWS + SWEEP_ROWS) as usize; // 0..4
                let (scale, si, g2) = if er < 2 {
                    let si = (er * 64 + ci).min(EXPOSURE_SUBSET_N - 1);
                    (2.0f32, si, PatchGroup::Exposure2x)
                } else {
                    let si = ((er - 2) * 64 + ci).min(EXPOSURE_SUBSET_N - 1);
                    (4.0f32, si, PatchGroup::Exposure4x)
                };
                let base = exposure_subset[si];
                (
                    g2,
                    [base[0] * scale, base[1] * scale, base[2] * scale],
                    exp_clamp[si],
                )
            };
            specs.push(PatchSpec {
                index,
                col,
                row,
                target_rec2020: rgb,
                group,
                clamped,
            });
        }
    }
    specs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimensions_and_patch_count() {
        let chart = SyntheticSweepChart::new();
        assert_eq!(chart.width(), 3584);
        assert_eq!(chart.height(), 2688);
        assert_eq!(chart.specs().len(), N_PATCHES);
    }

    #[test]
    fn neutral_ramp_is_log_monotone() {
        let first = neutral_ramp_lum(0);
        let last = neutral_ramp_lum(127);
        assert!((first - 0.001).abs() < 1e-5, "first={first}");
        assert!((last - 4.0).abs() < 1e-4, "last={last}");
        for i in 0..127 {
            assert!(
                neutral_ramp_lum(i + 1) > neutral_ramp_lum(i),
                "not monotone at {i}"
            );
        }
    }

    #[test]
    fn neutral_patches_are_neutral_and_sweep_in_gamut() {
        let chart = SyntheticSweepChart::new();
        for row in 0..NEUTRAL_ROWS {
            for col in 0..COLS {
                let [r, g, b] = chart.spec_at(col, row).target_rec2020;
                assert!(
                    (r - g).abs() < 1e-5 && (r - b).abs() < 1e-5,
                    "neutral ({col},{row}) not neutral: [{r},{g},{b}]"
                );
            }
        }
        for row in NEUTRAL_ROWS..NEUTRAL_ROWS + SWEEP_ROWS {
            for col in 0..COLS {
                let [r, g, b] = chart.spec_at(col, row).target_rec2020;
                assert!(
                    r >= 0.0 && g >= 0.0 && b >= 0.0,
                    "sweep ({col},{row}) negative: [{r},{g},{b}]"
                );
            }
        }
    }

    #[test]
    fn exposure_planes_are_brighter() {
        let chart = SyntheticSweepChart::new();
        for col in 0..COLS {
            let l2: f32 = chart.spec_at(col, 44).target_rec2020.iter().sum();
            let l4: f32 = chart.spec_at(col, 46).target_rec2020.iter().sum();
            assert!(l4 >= l2, "4× must be >= 2× at col {col}");
        }
    }

    #[test]
    fn spec_json_round_trips() {
        let chart = SyntheticSweepChart::new();
        let json = chart.spec_to_json();
        assert!(json.starts_with('[') && json.ends_with(']'));
        let entry_lines: Vec<_> = json.lines().filter(|l| l.contains("\"index\"")).collect();
        assert_eq!(entry_lines.len(), N_PATCHES);
        // Verify index 0 and last entry appear verbatim.
        for &idx in &[0usize, 3071] {
            let line = chart.specs()[idx].to_json_line();
            assert!(json.contains(&line), "missing entry {idx}");
        }
    }

    #[test]
    fn decodes_and_resolves_embedded_cm() {
        use crate::color::dcp::{profile_for_with_source, ProfileSource};
        use crate::decode::decode_bytes;
        let chart = SyntheticSweepChart::new();
        let raw = decode_bytes(&chart.write_to_bytes(), "dng").expect("must decode");
        assert!(!raw.color_matrices.is_empty(), "CM filtered as identity");
        let (_, src) = profile_for_with_source(&raw).expect("profile resolve");
        assert!(
            matches!(src, ProfileSource::EmbeddedCmOnly { .. }),
            "must be EmbeddedCmOnly, got {src:?}"
        );
    }

    #[test]
    fn oklab_d65_white_round_trips() {
        let lab = srgb_linear_to_oklab([1.0, 1.0, 1.0]);
        assert!(
            (lab[0] - 1.0).abs() < 1e-3 && lab[1].abs() < 1e-3 && lab[2].abs() < 1e-3,
            "D65 white Oklab {lab:?}"
        );
        let back = oklab_to_srgb_linear(lab);
        for c in 0..3 {
            assert!(
                (back[c] - 1.0).abs() < 1e-4,
                "D65 round-trip chan {c} = {}",
                back[c]
            );
        }
    }
}

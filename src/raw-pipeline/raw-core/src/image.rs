use std::collections::HashMap;

use crate::color::hsm::HsmTable;
use crate::color::illuminant::Illuminant;
use crate::color::profile_gain_table_map::ProfileGainTableMap;
use crate::color::profile_tone_curve::ProfileToneCurve;
use crate::math::Matrix3;

/// Tracks the colorspace of each `Image` at runtime. Stages `debug_assert!`
/// on this at their entry and exit. See spec docs/spec/04-color-management.md.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ColorSpace {
    /// Post-sensor-linearization, pre-demosaic. Single-channel mosaic per pixel.
    CameraNativeMosaic,
    /// Post-demosaic, pre-DCP. Three-channel camera-native linear RGB.
    CameraNativeLinearRgb,
    /// Post-DCP: scene-referred linear Rec.2020 D65, f32, **unbounded**.
    /// Main working space per spec § 04.
    SceneLinearRec2020,
    /// Post-AgX: display-linear Rec.2020, [0, 1] clamped.
    DisplayLinearRec2020,
    /// Post-gamut matrix: display-linear sRGB primaries, [0, 1].
    DisplayLinearSrgb,
    /// Post-gamut matrix: display-linear Display P3 primaries, [0, 1].
    /// The OETF that follows (`srgb_gamma_encode`) is identical to the sRGB
    /// path — IEC 61966-2-1 / 2.4-gamma — so stages that call
    /// `assert_space(DisplayLinearSrgb)` must be broadened via
    /// `is_display_linear()` when they are legal for both primaries sets.
    DisplayLinearP3,
    /// Post-gamma: sRGB gamma-encoded, u8-equivalent range.
    DisplayEncodedSrgb,
}

impl ColorSpace {
    /// Returns `true` for both `DisplayLinearSrgb` and `DisplayLinearP3`.
    ///
    /// Use this where a stage is legal for either primary set — most
    /// importantly `srgb_gamma_encode`, whose OETF (IEC 61966-2-1 / 2.4-gamma)
    /// is shared. Stages that care about primaries must still branch on the
    /// specific variant.
    #[inline]
    pub fn is_display_linear(self) -> bool {
        matches!(self, Self::DisplayLinearSrgb | Self::DisplayLinearP3)
    }
}

#[derive(Clone, Debug)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<[f32; 3]>,
    pub space: ColorSpace,
}

impl Image {
    pub fn new(width: u32, height: u32, space: ColorSpace) -> Self {
        let len = (width as usize) * (height as usize);
        Self {
            width,
            height,
            pixels: vec![[0.0; 3]; len],
            space,
        }
    }

    pub fn pixel_count(&self) -> usize {
        (self.width as usize) * (self.height as usize)
    }

    pub fn assert_space(&self, expected: ColorSpace) {
        debug_assert_eq!(
            self.space, expected,
            "expected colorspace {:?}, got {:?}",
            expected, self.space
        );
    }
}

/// CFA pattern. The four 2×2 Bayer variants are hand-rolled; X-Trans is a
/// 6×6 runtime-data pattern (different bodies report different layouts —
/// e.g. Fuji X-T20 uses a distinct layout when compression is enabled —
/// so the pattern can't be a hard-coded variant). The `LinearRgb` variant
/// is the special "no Bayer mosaic" case used for DNG
/// `PhotometricInterpretation = LinearRaw`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum CfaPattern {
    Rggb,
    Bggr,
    Grbg,
    Gbrg,
    /// 6×6 Fuji X-Trans CFA. The array is the flat 36-cell pattern in
    /// row-major order, each cell `0`/`1`/`2` for R/G/B. Sourced from
    /// rawler's per-body `XTransLayout` metadata block (see
    /// `crate::decode`). See tickets #417 / #420.
    XTrans([u8; 36]),
    /// Already-demosaiced 3-channel RGB. Source data is interleaved
    /// `[R₀ G₀ B₀ R₁ G₁ B₁ …]` with no Bayer mosaic pattern. Decoded
    /// from DNG `PhotometricInterpretation = LinearRaw (34892)`. The
    /// `linearize::linearraw_to_camera_rgb` helper converts directly
    /// to `CameraNativeLinearRgb`, skipping `sensor_linearize` and
    /// `demosaic::*`. Calling `color_at` on this variant is a runtime
    /// panic — callers must short-circuit before invoking it. See
    /// ticket #07.
    LinearRgb,
}

impl CfaPattern {
    /// Returns the color (0=R, 1=G, 2=B) at raw-space (x, y). Panics for
    /// `LinearRgb` — that variant has no Bayer position; callers must
    /// short-circuit before invoking this.
    pub fn color_at(self, x: u32, y: u32) -> u8 {
        let ex = (x & 1) as u8;
        let ey = (y & 1) as u8;
        match self {
            Self::Rggb => match (ex, ey) {
                (0, 0) => 0,
                (1, 0) => 1,
                (0, 1) => 1,
                _ => 2,
            },
            Self::Bggr => match (ex, ey) {
                (0, 0) => 2,
                (1, 0) => 1,
                (0, 1) => 1,
                _ => 0,
            },
            Self::Grbg => match (ex, ey) {
                (0, 0) => 1,
                (1, 0) => 0,
                (0, 1) => 2,
                _ => 1,
            },
            Self::Gbrg => match (ex, ey) {
                (0, 0) => 1,
                (1, 0) => 2,
                (0, 1) => 0,
                _ => 1,
            },
            Self::XTrans(pat) => {
                // 6×6 modulo lookup. `pat` is row-major with R=0, G=1, B=2.
                let cx = (x % 6) as usize;
                let cy = (y % 6) as usize;
                pat[cy * 6 + cx]
            }
            Self::LinearRgb => unreachable!(
                "CfaPattern::LinearRgb has no Bayer position; \
                 callers must short-circuit before invoking color_at"
            ),
        }
    }

    /// True if this pattern is a 2×2 Bayer mosaic (the four classic
    /// arrangements). Used by stages that fast-path on 2×2 phase and would
    /// produce garbage on X-Trans / LinearRgb.
    pub fn is_bayer_2x2(self) -> bool {
        matches!(self, Self::Rggb | Self::Bggr | Self::Grbg | Self::Gbrg)
    }

    /// True if this pattern is X-Trans (Fuji 6×6 CFA).
    pub fn is_xtrans(self) -> bool {
        matches!(self, Self::XTrans(_))
    }
}

#[derive(Clone, Debug)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub cfa: CfaPattern,
    pub black_level: [u32; 4], // per CFA position, indexed as [y_even*2 + x_even]
    pub white_level: u32,
    pub raw_data: Vec<u16>,
    /// Camera RGB reading of a neutral patch in the scene, G-normalized so
    /// the green channel is exactly 1.0. Matches the DNG `AsShotNeutral`
    /// semantics (§ 1.4.4.1): for the neutral, `camera_rgb = AsShotNeutral`,
    /// so `inv(ColorMatrix_scene) * AsShotNeutral = XYZ_scene_white`.
    ///
    /// Note: rawler's `wb_coeffs` are the *reciprocal* — WB multipliers (gains
    /// that balance the camera reading to 1). `decode::decode_bytes` inverts
    /// rawler's values before storing them here so downstream DCP math can
    /// treat this field per DNG spec.
    pub as_shot_neutral: [f32; 3],
    /// Correlated color temperature derived from metadata, if available.
    pub as_shot_cct: Option<f32>,
    pub camera_make: String,
    pub camera_model: String,
    /// DNG `UniqueCameraModel` tag (50708) when present. Distinct from
    /// `camera_model` for mobile bodies whose lens variants share a model
    /// name — e.g. iPhone 12 Pro DNGs all report `Model="iPhone 12 Pro"`
    /// but `UniqueCameraModel="iPhone13,3 back camera"` /
    /// `"iPhone13,3 back telephoto camera"` etc. The bundled-DCP lookup
    /// in `color::profile_loader` keys off this when present and falls
    /// back to `camera_model` when absent. Vendor RAWs (CR2, ARW, NEF, …)
    /// typically lack the tag; their `camera_model` already matches
    /// the upstream DCP UCM convention (`"Canon EOS 5D Mark IV"` etc.) so the
    /// fallback path works there without changes.
    pub unique_camera_model: Option<String>,
    /// Camera color matrices by calibration illuminant. Each is XYZ→camera per
    /// DNG spec (inverse at apply-time to get camera→XYZ). Used by DCP for dual-
    /// illuminant reciprocal-CCT interpolation (spec § 3.4).
    ///
    /// **Only populated when the source FILE itself shipped `ColorMatrix1`
    /// or `ColorMatrix2` tags** — i.e. DNG-shaped sources. Vendor RAW
    /// formats (.fff/.cr2/.arw/.nef/etc.) leave this empty even though
    /// rawler internally substitutes its own dcraw-lineage matrices for
    /// debayer/WB purposes; those substitutes have historically regressed
    /// color (test_0004 Hasselblad .fff: 7.24 → 8.86 ΔE if surfaced as
    /// "embedded"). See `decode.rs` § 8 for the `cm_in_ifd` gate. When
    /// this map is empty, `dcp::profile_for_with_source` falls through
    /// to the bundled-profile path; if that also misses, to the generic
    /// D65 → Rec.2020 fallback (#424). Never identity.
    pub color_matrices: HashMap<Illuminant, Matrix3>,
    /// DNG `ForwardMatrix1` / `ForwardMatrix2` (tags 50964 / 50965), keyed by
    /// the matching `CalibrationIlluminant`. Each is camera→XYZ-D50 per spec
    /// § 1.4.4.3 — when present, the DCP path uses it instead of Bradford CA
    /// (more accurate adaptation tuned per camera). May be empty when the DNG
    /// omits the tags (most non-Apple bodies). Indexed by the same illuminants
    /// as `color_matrices` so the dual-CM CCT lerp can pair them up.
    pub forward_matrices: HashMap<Illuminant, Matrix3>,
    /// EXIF orientation (TIFF tag 0x0112) as captured by the camera. Applied
    /// as a final rotation/flip pass on the rendered RGB buffer to match the
    /// reference viewer's display orientation. `Normal` when metadata is
    /// absent or unreadable.
    pub orientation: ExifOrientation,
    /// Per-body exposure calibration in EV. DNG spec § C.1.2 (BaselineExposure,
    /// tag 50730): "applied as a gain in a scene-linear color space prior to
    /// the color-space transform". Corrects the systematic gap between
    /// hardware-saturation-normalized sensor values and the scene-referred
    /// 0.18-mid-gray reference. For DNG files this is read from the TIFF tag;
    /// for vendor RAW it falls back to [`camera_calibration`]. Default is 0.0.
    pub baseline_exposure: f32,
    /// DNG ProfileHueSatMap tables (`ProfileHueSatMapData1` / `Data2`,
    /// tags 50938 / 50939), keyed by the matching `CalibrationIlluminant`.
    /// Applied as a per-pixel HSV-space lookup inside the DCP path — see
    /// `dcp::apply` for the integration point. Indexed by the same
    /// illuminants as `color_matrices` so dual-illuminant CCT interpolation
    /// (DNG 1.6 § 6.6.5) can pair each HSM to its calibration matrix even
    /// when the DNG stores `CalibrationIlluminant1` warmer than
    /// `CalibrationIlluminant2`. Empty for vendor RAW formats that don't
    /// ship a DCP profile and for DNGs that omit the HSM tags.
    pub hsm_data: HashMap<Illuminant, HsmTable>,
    /// DNG ProfileLookTable (`ProfileLookTableData`, tag 50982). Single table
    /// — the spec doesn't define a dual-illuminant variant. Applied AFTER
    /// the DCP / chromatic adaptation step in scene-linear Rec.2020 D65
    /// (DNG 1.6 § 6.7), before any user-space adjustments. Encodes the
    /// camera-profile-baked "look" (e.g. "Camera Vivid" vs "Camera Standard").
    pub plt: Option<HsmTable>,
    /// DNG ProfileToneCurve (tag 50940). 1D piecewise-linear tone curve, stored
    /// as `(input, output)` float pairs both in [0, 1]. Applied in
    /// profile-working space (linear ProPhoto D50, per DNG 1.4 § 6.4.4 — the
    /// same space HSM/PLT operate in). When `None`, the stage is skipped.
    /// Apple iPhone DNGs ship a 257-pair PTC; most other vendors (Hasselblad,
    /// Leica, Nikon, ...) omit it.
    pub profile_tone_curve: Option<ProfileToneCurve>,
    /// DNG ProfileGainTableMap (tag 52525, DNG 1.6 § 6.8). Spatially-varying
    /// per-channel gain map; lives in a SubIFD on iPhone DNGs (reachable via
    /// `dng_ifd_walker`). Applied in scene-linear space after PLT. `None` for
    /// any RAW that doesn't ship the tag, or when the binary header cannot be
    /// parsed confidently — see [`ProfileGainTableMap::from_bytes`].
    pub profile_gain_table_map: Option<ProfileGainTableMap>,
    /// DNG `DefaultCropOrigin` / `DefaultCropSize` in raw-sensor coordinates.
    /// Encodes the camera-recommended render rectangle — typically excludes
    /// the optical-black border around `ActiveArea` plus a few-px demosaic
    /// margin. Populated from rawler's `crop_area`. `None` when the source
    /// ships neither the rawler crop nor the raw DNG tags, in which case
    /// the pipeline renders the full sensor (matches ACR's fallback). See
    /// [`CropRect`] and the apply step in `pipeline::develop`.
    pub crop_rect: Option<CropRect>,
    pub iso: u32,
    pub noise_profile: Option<Vec<f32>>,
    /// DNG OpcodeList3 corrections parsed at decode time.
    pub opcode_list3: Option<(crate::pipeline::pano::opcodes::OpcodeList3, crate::pipeline::pano::opcodes::ActiveAreaRect)>,
}

/// DNG camera-recommended render rectangle in raw-sensor coordinates.
///
/// Encodes the `DefaultCropOrigin` (tag 50719) + `DefaultCropSize` (tag 50720)
/// pair: the sub-rectangle of the full sensor that the camera vendor wants
/// rendered. Most sensors carry a few-pixel optical-black border (covered by
/// `ActiveArea`) plus a small extra demosaic-safe margin past the active area;
/// `DefaultCrop*` is what gets shown to the user.
///
/// Populated by [`crate::decode::decode_bytes`] from rawler's `crop_area`
/// field — rawler reads it consistently for DNG, CR2, CR3, ARW, NEF, RAF,
/// ORF, RW2 (i.e. every vendor format we support that ships the tags).
/// Apple iPhone DNGs (test_0013) and a few older DNGs (test_0002) ship
/// neither the rawler-surfaced crop nor the raw DNG tags — those decode
/// with `crop_rect = None`, which the pipeline treats as "no crop"
/// (full-sensor render), matching ACR's behaviour for those fixtures.
///
/// Coordinates are sensor-absolute (x, y, w, h) in raw-pixel units. The
/// pipeline applies the crop post-demosaic, so for half-res Preview the
/// rect is halved at apply time (see `pipeline::develop::crop_to_default`).
/// Orientation is applied AFTER crop on the developed RGB buffer — this
/// mirrors the DNG spec's ordering (§ 6.3) and what ACR / dng_render does.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl CropRect {
    /// Construct a rect, clamping to `(sensor_w, sensor_h)` so a slightly
    /// over-large rect from a malformed source can't index out of bounds.
    /// Returns `None` if the clamp would produce a degenerate (zero-area)
    /// rect — caller treats that as "no crop."
    pub fn clamped(x: u32, y: u32, w: u32, h: u32, sensor_w: u32, sensor_h: u32) -> Option<Self> {
        let x = x.min(sensor_w);
        let y = y.min(sensor_h);
        let w = w.min(sensor_w.saturating_sub(x));
        let h = h.min(sensor_h.saturating_sub(y));
        if w == 0 || h == 0 {
            return None;
        }
        Some(Self { x, y, w, h })
    }
}

/// EXIF orientation (TIFF tag 0x0112). Values 1-8 per the spec. `Normal` is
/// the identity; `Rotate90` means the displayed image is the sensor rotated
/// 90° clockwise, etc. See pipeline::apply_orientation for the pixel-level
/// interpretation.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum ExifOrientation {
    #[default]
    Normal, // 1
    HorizontalFlip, // 2
    Rotate180,      // 3
    VerticalFlip,   // 4
    Transpose,      // 5
    Rotate90,       // 6
    Transverse,     // 7
    Rotate270,      // 8
}

impl ExifOrientation {
    pub fn from_u16(v: u16) -> Self {
        match v {
            2 => Self::HorizontalFlip,
            3 => Self::Rotate180,
            4 => Self::VerticalFlip,
            5 => Self::Transpose,
            6 => Self::Rotate90,
            7 => Self::Transverse,
            8 => Self::Rotate270,
            _ => Self::Normal,
        }
    }

    /// True if this orientation swaps width and height (transpose-family).
    pub fn swaps_wh(self) -> bool {
        matches!(
            self,
            Self::Transpose | Self::Rotate90 | Self::Transverse | Self::Rotate270
        )
    }

    /// Map a rect in DISPLAY-oriented coordinates to a rect in SENSOR
    /// (un-oriented) coordinates. `sw`/`sh` are the sensor dimensions.
    /// Used by the tile FFI so callers can pass display-oriented tile
    /// coords (which is what they care about) and the Rust pipeline
    /// translates to the sensor coords it actually crops from.
    ///
    /// For transpose-family orientations the rect's width and height
    /// swap (because display W = sensor H and vice versa).
    pub fn display_rect_to_sensor(
        self,
        dx: u32,
        dy: u32,
        dw: u32,
        dh: u32,
        sw: u32,
        sh: u32,
    ) -> (u32, u32, u32, u32) {
        match self {
            Self::Normal => (dx, dy, dw, dh),
            Self::HorizontalFlip => (sw.saturating_sub(dx + dw), dy, dw, dh),
            Self::Rotate180 => (
                sw.saturating_sub(dx + dw),
                sh.saturating_sub(dy + dh),
                dw,
                dh,
            ),
            Self::VerticalFlip => (dx, sh.saturating_sub(dy + dh), dw, dh),
            // Transpose family — swap dims. The inverse mapping below
            // mirrors the per-pixel reads in `apply_orientation` (see
            // table at lines ~191-200): for each, sensor (sx, sy) is
            // derived from display (xp, yp). Apply the same to rect
            // corners and take the bounding box; for axis-aligned 90°
            // rotations / transposes the result simplifies to the rect
            // expressions below.
            Self::Transpose => (dy, dx, dh, dw),
            Self::Rotate90 => (dy, sh.saturating_sub(dx + dw), dh, dw),
            Self::Transverse => (
                sw.saturating_sub(dy + dh),
                sh.saturating_sub(dx + dw),
                dh,
                dw,
            ),
            Self::Rotate270 => (sw.saturating_sub(dy + dh), dx, dh, dw),
        }
    }
}

/// Apply EXIF orientation to a packed-u8-RGB buffer. Returns `(new_w, new_h,
/// rotated_bytes)`. The input buffer is unchanged; caller substitutes the
/// returned triple. `Normal` is a cheap clone of the input.
///
/// The per-orientation source mapping is derived so that applying the
/// operation rotates the sensor frame into display orientation — the
/// displayed-image convention used by EXIF-aware viewers.
pub fn apply_orientation(
    rgb: &[u8],
    w: u32,
    h: u32,
    orient: ExifOrientation,
) -> (u32, u32, Vec<u8>) {
    let (sw, sh) = (w as usize, h as usize);
    debug_assert_eq!(rgb.len(), sw * sh * 3, "RGB buffer size mismatch");

    if orient == ExifOrientation::Normal {
        return (w, h, rgb.to_vec());
    }

    let (new_w, new_h) = if orient.swaps_wh() { (h, w) } else { (w, h) };
    let (dw, dh) = (new_w as usize, new_h as usize);
    let mut out = vec![0u8; dw * dh * 3];

    for yp in 0..dh {
        for xp in 0..dw {
            let (sx, sy) = match orient {
                ExifOrientation::Normal => (xp, yp),
                ExifOrientation::HorizontalFlip => (sw - 1 - xp, yp),
                ExifOrientation::Rotate180 => (sw - 1 - xp, sh - 1 - yp),
                ExifOrientation::VerticalFlip => (xp, sh - 1 - yp),
                ExifOrientation::Transpose => (yp, xp),
                ExifOrientation::Rotate90 => (yp, sh - 1 - xp),
                ExifOrientation::Transverse => (sw - 1 - yp, sh - 1 - xp),
                ExifOrientation::Rotate270 => (sw - 1 - yp, xp),
            };
            let si = (sy * sw + sx) * 3;
            let di = (yp * dw + xp) * 3;
            out[di] = rgb[si];
            out[di + 1] = rgb[si + 1];
            out[di + 2] = rgb[si + 2];
        }
    }
    (new_w, new_h, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2×3 RGB fixture: each pixel's R channel encodes a unique tag letter
    /// (ASCII); G = 0, B = 0. After orientation, we can read out the tag
    /// sequence to verify the pixel mapping. The image looks like:
    ///
    ///   A B
    ///   C D
    ///   E F
    fn tag_fixture_2x3() -> (u32, u32, Vec<u8>) {
        let tags = [b'A', b'B', b'C', b'D', b'E', b'F'];
        let mut v = Vec::with_capacity(18);
        for t in tags {
            v.extend_from_slice(&[t, 0, 0]);
        }
        (2, 3, v)
    }

    fn read_tags(rgb: &[u8]) -> Vec<char> {
        rgb.chunks_exact(3).map(|c| c[0] as char).collect()
    }

    #[test]
    fn apply_orientation_normal_is_identity() {
        let (w, h, rgb) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Normal);
        assert_eq!((nw, nh), (w, h));
        assert_eq!(read_tags(&out), vec!['A', 'B', 'C', 'D', 'E', 'F']);
    }

    #[test]
    fn apply_orientation_rotate90_cw_2x3_to_3x2() {
        // 2×3 source →[90° CW]→ 3×2 result:
        //   A B             E C A
        //   C D       ⇒     F D B
        //   E F
        let (w, h, rgb) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate90);
        assert_eq!((nw, nh), (3, 2));
        assert_eq!(read_tags(&out), vec!['E', 'C', 'A', 'F', 'D', 'B']);
    }

    #[test]
    fn apply_orientation_rotate180_flips_both() {
        let (w, h, rgb) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate180);
        assert_eq!((nw, nh), (w, h));
        // Reverse of A B C D E F → F E D C B A
        assert_eq!(read_tags(&out), vec!['F', 'E', 'D', 'C', 'B', 'A']);
    }

    #[test]
    fn apply_orientation_horizontal_flip() {
        let (w, h, rgb) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::HorizontalFlip);
        assert_eq!((nw, nh), (w, h));
        //   A B → B A
        //   C D → D C
        //   E F → F E
        assert_eq!(read_tags(&out), vec!['B', 'A', 'D', 'C', 'F', 'E']);
    }

    #[test]
    fn apply_orientation_rotate270_ccw_2x3_to_3x2() {
        // 2×3 source →[270° CW = 90° CCW]→ 3×2 result:
        //   A B             B D F
        //   C D       ⇒     A C E
        //   E F
        let (w, h, rgb) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate270);
        assert_eq!((nw, nh), (3, 2));
        assert_eq!(read_tags(&out), vec!['B', 'D', 'F', 'A', 'C', 'E']);
    }

    #[test]
    fn apply_orientation_rotate90_then_rotate270_round_trips() {
        let (w, h, rgb) = tag_fixture_2x3();
        let (w1, h1, rgb1) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate90);
        let (w2, h2, rgb2) = apply_orientation(&rgb1, w1, h1, ExifOrientation::Rotate270);
        assert_eq!((w2, h2), (w, h));
        assert_eq!(rgb2, rgb);
    }

    #[test]
    fn new_image_zero_initialized() {
        let img = Image::new(4, 2, ColorSpace::SceneLinearRec2020);
        assert_eq!(img.pixel_count(), 8);
        assert!(img.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]));
    }

    #[test]
    fn rggb_pattern_positions() {
        let p = CfaPattern::Rggb;
        assert_eq!(p.color_at(0, 0), 0); // R
        assert_eq!(p.color_at(1, 0), 1); // G
        assert_eq!(p.color_at(0, 1), 1); // G
        assert_eq!(p.color_at(1, 1), 2); // B
    }

    #[test]
    fn bggr_pattern_positions() {
        let p = CfaPattern::Bggr;
        assert_eq!(p.color_at(0, 0), 2);
        assert_eq!(p.color_at(1, 1), 0);
    }

    #[test]
    #[should_panic(expected = "expected colorspace")]
    fn assert_space_panics_on_mismatch() {
        let img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.assert_space(ColorSpace::DisplayLinearSrgb);
    }
}

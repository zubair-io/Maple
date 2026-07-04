//! Synthetic scene-linear inputs for the diagnostic detectors.
//!
//! Every generator returns a fully-formed `Image` in `SceneLinearRec2020`
//! at f32 — the same colorspace and dtype the develop chain hands to the
//! view transform. Detectors feed these buffers through
//! `render_from_scene_linear` (or with the slider chain, when a clarity /
//! dehaze variant is under test) and inspect the resulting per-stage EXR
//! dumps via the existing `MAPLE_STAGE_DUMP` infrastructure.
//!
//! Four failure modes are covered:
//!
//! * `neutral_ramp` — exercises monotonicity / R==G==B / shadow histogram
//!   gaps. Symptoms: shadow magenta-banding, stepped gradients.
//! * `hue_patch` — six saturated primaries × six exposures. Symptoms:
//!   per-channel hue rotation at the AgX shoulder (red→pink, blue→magenta).
//! * `halo_disk` — anti-aliased dark disk on bright background. Symptoms:
//!   clarity / dehaze unsharp-mask overshoot at the edge.
//! * `saturated_neutral_edge` — half-saturated-primary / half-neutral step.
//!   Symptoms: per-channel local-contrast stages (clarity, texture,
//!   capture-sharpen) producing cross-channel halos because the channel
//!   with no edge gets no boost while the others overshoot, leaving a
//!   complementary-color fringe on the neutral side.
//!
//! Used by `maple-cli synthetic`. See `src/scripts/banding_check.py`,
//! `hue_stability.py`, `halo_check.py`.

use crate::color::oklab::oklab_to_rec2020;
use crate::image::{ColorSpace, Image};

/// Spec mid-gray used as the brightness anchor for the synthetic inputs.
/// Matches `view::agx::AGX_MID_GRAY` (0.18) — keeps the AgX log-encoding
/// math at well-known anchor positions for every kind of synthetic patch.
const MID_GRAY: f32 = 0.18;

/// One of the six saturated colour primaries that get pumped through the
/// hue-stability detector. R / G / B are the Rec.2020 primaries; C / M / Y
/// are their pairwise sums.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Primary {
    Red,
    Green,
    Blue,
    Cyan,
    Magenta,
    Yellow,
}

impl Primary {
    /// Parse the single-letter flag used by `maple-cli synthetic --primary`.
    pub fn from_letter(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "r" | "red" => Some(Primary::Red),
            "g" | "green" => Some(Primary::Green),
            "b" | "blue" => Some(Primary::Blue),
            "c" | "cyan" => Some(Primary::Cyan),
            "m" | "magenta" => Some(Primary::Magenta),
            "y" | "yellow" => Some(Primary::Yellow),
            _ => None,
        }
    }

    /// Letter the CLI uses to name this primary on disk (e.g. dump dir
    /// suffixes). One letter so output dirs sort cleanly.
    pub fn letter(self) -> &'static str {
        match self {
            Primary::Red => "r",
            Primary::Green => "g",
            Primary::Blue => "b",
            Primary::Cyan => "c",
            Primary::Magenta => "m",
            Primary::Yellow => "y",
        }
    }

    /// Unit triple in Rec.2020-space — the "1.0" magnitude for this
    /// primary. Multiplied by the EV-scaled mid-gray to get the final
    /// scene-linear value. Exposed `pub(crate)` so downstream tests
    /// (e.g. `stages::clarity` regression assertions) can reuse the
    /// same source of truth without duplicating the match.
    pub(crate) fn rgb_unit(self) -> [f32; 3] {
        match self {
            Primary::Red => [1.0, 0.0, 0.0],
            Primary::Green => [0.0, 1.0, 0.0],
            Primary::Blue => [0.0, 0.0, 1.0],
            Primary::Cyan => [0.0, 1.0, 1.0],
            Primary::Magenta => [1.0, 0.0, 1.0],
            Primary::Yellow => [1.0, 1.0, 0.0],
        }
    }
}

/// 1-D linear 0→1 ramp, tiled vertically. Width pixels along x carry the
/// ramp value `x / (width - 1)`; height is just for batch-stat sampling
/// (more rows = denser histogram). Identical R / G / B per pixel — any
/// per-row R-G drift downstream is purely the pipeline's fault.
pub fn neutral_ramp(width: u32, height: u32) -> Image {
    assert!(width >= 2, "neutral_ramp: width must be >= 2");
    assert!(height >= 1, "neutral_ramp: height must be >= 1");
    let mut img = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    let denom = (width - 1) as f32;
    for y in 0..height as usize {
        for x in 0..width as usize {
            let v = (x as f32) / denom;
            img.pixels[y * width as usize + x] = [v, v, v];
        }
    }
    img
}

/// Uniform saturated primary at `MID_GRAY * 2^ev`. The output is constant
/// across all pixels — the detector picks one pixel and measures its hue
/// angle in CAM16-UCS post-AgX.
pub fn hue_patch(primary: Primary, ev: f32, width: u32, height: u32) -> Image {
    assert!(width >= 1, "hue_patch: width must be >= 1");
    assert!(height >= 1, "hue_patch: height must be >= 1");
    let scale = MID_GRAY * ev.exp2();
    let unit = primary.rgb_unit();
    let rgb = [unit[0] * scale, unit[1] * scale, unit[2] * scale];
    let mut img = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = rgb;
    }
    img
}

/// Anti-aliased dark disk on a bright background. Background sits at
/// `Y ≈ 0.8` (neutral, so each channel is also 0.8); disk sits at
/// `Y ≈ 0.2`. Centered, diameter = `min(width, height) * 0.6`. The
/// transition is a 1-pixel smoothstep at the radius — gives the halo
/// detector enough edge gradient to sample a radial profile without
/// per-pixel aliasing noise contaminating the overshoot estimate.
pub fn halo_disk(width: u32, height: u32) -> Image {
    assert!(width >= 4, "halo_disk: width must be >= 4");
    assert!(height >= 4, "halo_disk: height must be >= 4");
    const BG: f32 = 0.8;
    const FG: f32 = 0.2;
    let cx = (width as f32 - 1.0) * 0.5;
    let cy = (height as f32 - 1.0) * 0.5;
    let radius = (width.min(height) as f32) * 0.3;
    let mut img = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    for y in 0..height as usize {
        for x in 0..width as usize {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let d = (dx * dx + dy * dy).sqrt();
            // Smoothstep across a 1-pixel-wide band centred on the
            // nominal radius. `t = 0` inside the disk → FG; `t = 1`
            // outside → BG.
            let t = ((d - radius + 0.5) / 1.0).clamp(0.0, 1.0);
            let t = t * t * (3.0 - 2.0 * t);
            let v = FG * (1.0 - t) + BG * t;
            img.pixels[y * width as usize + x] = [v, v, v];
        }
    }
    img
}

/// Half-saturated-primary / half-neutral vertical step. The left half
/// carries a uniform neutral grey (R=G=B=`neutral`); the right half
/// carries a uniform saturated primary (one channel = `saturated`, the
/// other two = 0). The two halves are independent values — the caller
/// picks whatever neutral / saturated levels exercise the regression
/// they care about; this generator does not pin them to equal luma.
/// Width must be even — the split is exactly at `width / 2`. Height is
/// just for batch-stat sampling (constant along y).
///
/// Used by the clarity / texture / capture-sharpen luminance-only
/// regression tests: under a per-channel unsharp mask, the channel
/// with no step (the saturated channel on the neutral side, or any of
/// the zero channels on the saturated side) gets no detail boost while
/// the other channels overshoot, leaving a cyan-on-red (or red-on-cyan,
/// etc.) fringe across the edge. Under a luminance-only implementation
/// the per-pixel R:G:B ratio is preserved by a single scalar multiply,
/// so the neutral side stays neutral and the saturated side stays
/// fully-saturated everywhere.
pub fn saturated_neutral_edge(
    primary: Primary,
    neutral: f32,
    saturated: f32,
    width: u32,
    height: u32,
) -> Image {
    assert!(width >= 2, "saturated_neutral_edge: width must be >= 2");
    assert!(
        width % 2 == 0,
        "saturated_neutral_edge: width must be even so the split is sharp"
    );
    assert!(height >= 1, "saturated_neutral_edge: height must be >= 1");
    let unit = primary.rgb_unit();
    let sat_rgb = [
        unit[0] * saturated,
        unit[1] * saturated,
        unit[2] * saturated,
    ];
    let neu_rgb = [neutral, neutral, neutral];
    let w = width as usize;
    let mut img = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    for y in 0..height as usize {
        for x in 0..w {
            img.pixels[y * w + x] = if x < w / 2 { neu_rgb } else { sat_rgb };
        }
    }
    img
}

/// A named constant-hue axis for [`chroma_ramp`], anchored to a real-world
/// color family rather than an arbitrary angle — the #1627 banding gate
/// wants coverage on the hues where pushed-color banding (#1621) actually
/// shows up in user reports (foliage, sky/blue, skin), not just a generic
/// hue sweep (that broader sweep already exists as a pure-function unit
/// test in `color::oklab_gamut::tests::soft_compress_invariants_across_hue_and_lightness`).
///
/// `(hue_deg, l)` pairs are derived from linearized sRGB approximations of
/// each named color (see the derivation note on each variant); `hue_deg` is
/// the Oklab hue angle in degrees, `l` is the Oklab lightness the ramp holds
/// constant while chroma sweeps from 0 out past the gamut hull.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum RampHue {
    /// Foliage yellow-green — the #1621 repro hue (linearized sRGB
    /// ~[0.35, 0.55, 0.05] → Oklab hue ≈ 123°, L ≈ 0.77).
    FoliageYellowGreen,
    /// Saturated blue primary (linear sRGB [0, 0, 1] → Oklab hue ≈ 264°,
    /// L ≈ 0.45).
    Blue,
    /// Saturated magenta (linear sRGB [1, 0, 1] → Oklab hue ≈ 328°,
    /// L ≈ 0.70).
    Magenta,
    /// Caucasian mid-tone skin (linearized sRGB ~[0.62, 0.42, 0.32] →
    /// Oklab hue ≈ 53°, L ≈ 0.77).
    Skin,
}

impl RampHue {
    /// `(hue_degrees, oklab_lightness)` for this axis.
    pub fn hue_and_lightness(self) -> (f32, f32) {
        match self {
            RampHue::FoliageYellowGreen => (123.4, 0.768),
            RampHue::Blue => (264.1, 0.452),
            RampHue::Magenta => (328.4, 0.702),
            RampHue::Skin => (53.1, 0.773),
        }
    }

    /// Short slug used to name dump subdirectories / CLI flags.
    pub fn slug(self) -> &'static str {
        match self {
            RampHue::FoliageYellowGreen => "foliage",
            RampHue::Blue => "blue",
            RampHue::Magenta => "magenta",
            RampHue::Skin => "skin",
        }
    }

    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "foliage" => Some(RampHue::FoliageYellowGreen),
            "blue" => Some(RampHue::Blue),
            "magenta" => Some(RampHue::Magenta),
            "skin" => Some(RampHue::Skin),
            _ => None,
        }
    }
}

/// Constant-lightness, constant-hue Oklab chroma ramp in scene-linear
/// Rec.2020 — the #1627/#1621 banding-gate fixture. Column `x` carries
/// chroma `C_MAX * x / (width - 1)`, held at `hue`'s fixed Oklab `(L, hue)`
/// and converted back to Rec.2020 via [`oklab_to_rec2020`]. The ramp runs
/// well past the sRGB/Rec.2020 gamut hull for every named hue (`C_MAX`
/// chosen generously per the #1621 repro's C≈0.45 span) so the second half
/// of the ramp exercises the AgX + display-encode gamut compressors' soft
/// knee — a hard clip collapses that half onto a single output color
/// (the #1621 defect); the fix keeps it monotonic.
///
/// Unlike `hue_patch` (a single uniform saturated patch, used by the
/// hue-stability detector), this generator's whole point is the smooth
/// *gradient* — `banding_check.py`'s second-difference metric measures
/// spikes in exactly this kind of per-pixel monotonic progression.
pub fn chroma_ramp(hue: RampHue, width: u32, height: u32) -> Image {
    assert!(width >= 2, "chroma_ramp: width must be >= 2");
    assert!(height >= 1, "chroma_ramp: height must be >= 1");
    const C_MAX: f32 = 0.45; // past the Rec.2020/sRGB hull for every named hue
    let (hue_deg, l) = hue.hue_and_lightness();
    let h = hue_deg.to_radians();
    let (sin_h, cos_h) = h.sin_cos();
    let denom = (width - 1) as f32;
    let mut img = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    for x in 0..width as usize {
        let c = C_MAX * (x as f32) / denom;
        let rgb = oklab_to_rec2020([l, c * cos_h, c * sin_h]);
        for y in 0..height as usize {
            img.pixels[y * width as usize + x] = rgb;
        }
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_ramp_endpoints_are_zero_and_one() {
        let img = neutral_ramp(256, 4);
        assert_eq!(img.pixels[0], [0.0, 0.0, 0.0]);
        let last = img.pixels[255];
        assert!((last[0] - 1.0).abs() < 1e-6);
        assert_eq!(last[0], last[1]);
        assert_eq!(last[1], last[2]);
    }

    #[test]
    fn neutral_ramp_is_monotone_and_achromatic() {
        let img = neutral_ramp(64, 1);
        for i in 1..64 {
            let prev = img.pixels[i - 1][0];
            let cur = img.pixels[i][0];
            assert!(cur >= prev, "non-monotone at {}: {} -> {}", i, prev, cur);
            let p = img.pixels[i];
            assert_eq!(p[0], p[1], "R != G at {}: {:?}", i, p);
            assert_eq!(p[1], p[2], "G != B at {}: {:?}", i, p);
        }
    }

    #[test]
    fn neutral_ramp_rows_are_identical() {
        let img = neutral_ramp(16, 8);
        let w = 16usize;
        for y in 1..8 {
            for x in 0..w {
                assert_eq!(img.pixels[y * w + x], img.pixels[x]);
            }
        }
    }

    #[test]
    fn hue_patch_is_uniform_and_carries_expected_chroma() {
        let img = hue_patch(Primary::Red, 0.0, 4, 4);
        let first = img.pixels[0];
        for p in &img.pixels {
            assert_eq!(*p, first, "hue patch not uniform");
        }
        // EV=0 → MID_GRAY; red unit → R=0.18, G=0, B=0.
        assert!((first[0] - MID_GRAY).abs() < 1e-6);
        assert_eq!(first[1], 0.0);
        assert_eq!(first[2], 0.0);
    }

    #[test]
    fn hue_patch_exposures_scale_by_two() {
        let lo = hue_patch(Primary::Green, 0.0, 1, 1).pixels[0][1];
        let hi = hue_patch(Primary::Green, 1.0, 1, 1).pixels[0][1];
        assert!(
            (hi / lo - 2.0).abs() < 1e-5,
            "EV+1 should double: {} -> {}",
            lo,
            hi
        );
    }

    #[test]
    fn hue_patch_yellow_is_red_plus_green() {
        let yellow = hue_patch(Primary::Yellow, 0.0, 1, 1).pixels[0];
        assert!((yellow[0] - MID_GRAY).abs() < 1e-6);
        assert!((yellow[1] - MID_GRAY).abs() < 1e-6);
        assert_eq!(yellow[2], 0.0);
    }

    #[test]
    fn primary_from_letter_round_trips() {
        for p in [
            Primary::Red,
            Primary::Green,
            Primary::Blue,
            Primary::Cyan,
            Primary::Magenta,
            Primary::Yellow,
        ] {
            assert_eq!(Primary::from_letter(p.letter()), Some(p));
        }
        assert_eq!(Primary::from_letter("RED"), Some(Primary::Red));
        assert!(Primary::from_letter("k").is_none());
    }

    #[test]
    fn halo_disk_center_is_dark_and_corners_are_bright() {
        let img = halo_disk(128, 128);
        let center = img.pixels[64 * 128 + 64];
        assert!(center[0] < 0.3, "center should be dark, got {}", center[0]);
        let corner = img.pixels[0];
        assert!(
            corner[0] > 0.7,
            "corner should be bright, got {}",
            corner[0]
        );
    }

    #[test]
    fn halo_disk_is_achromatic_everywhere() {
        let img = halo_disk(64, 64);
        for p in &img.pixels {
            assert_eq!(p[0], p[1]);
            assert_eq!(p[1], p[2]);
        }
    }

    #[test]
    fn saturated_neutral_edge_left_half_is_neutral() {
        let img = saturated_neutral_edge(Primary::Red, 0.5, 0.7, 16, 4);
        for y in 0..4 {
            for x in 0..8 {
                let p = img.pixels[y * 16 + x];
                assert_eq!(
                    p,
                    [0.5, 0.5, 0.5],
                    "left pixel ({},{}) drifted: {:?}",
                    x,
                    y,
                    p
                );
            }
        }
    }

    #[test]
    fn saturated_neutral_edge_right_half_is_saturated_primary() {
        let img = saturated_neutral_edge(Primary::Red, 0.5, 0.7, 16, 4);
        for y in 0..4 {
            for x in 8..16 {
                let p = img.pixels[y * 16 + x];
                assert_eq!(
                    p,
                    [0.7, 0.0, 0.0],
                    "right pixel ({},{}) drifted: {:?}",
                    x,
                    y,
                    p
                );
            }
        }
    }

    #[test]
    fn saturated_neutral_edge_works_for_each_primary() {
        for primary in [
            Primary::Red,
            Primary::Green,
            Primary::Blue,
            Primary::Cyan,
            Primary::Magenta,
            Primary::Yellow,
        ] {
            let img = saturated_neutral_edge(primary, 0.4, 0.6, 8, 1);
            // Left half: achromatic at `neutral`.
            for x in 0..4 {
                assert_eq!(img.pixels[x], [0.4, 0.4, 0.4]);
            }
            // Right half: each channel is either 0 or `saturated`.
            for x in 4..8 {
                let p = img.pixels[x];
                for &c in &p {
                    assert!(
                        c == 0.0 || (c - 0.6).abs() < 1e-6,
                        "primary {:?}: pixel {} channel must be 0 or saturated; got {:?}",
                        primary,
                        x,
                        p
                    );
                }
            }
        }
    }

    #[test]
    fn halo_disk_edge_band_is_anti_aliased() {
        // Walk from centre outward along the x axis; the transition from
        // FG to BG should span more than one pixel (some pixel sits at
        // an intermediate value).
        let img = halo_disk(64, 64);
        let cy = 32usize;
        let intermediates: usize = (0..64)
            .filter(|&x| {
                let v = img.pixels[cy * 64 + x][0];
                v > 0.25 && v < 0.75
            })
            .count();
        assert!(
            intermediates >= 1,
            "halo edge is not anti-aliased (0 intermediate pixels)"
        );
    }

    #[test]
    fn ramp_hue_slug_round_trips() {
        for h in [
            RampHue::FoliageYellowGreen,
            RampHue::Blue,
            RampHue::Magenta,
            RampHue::Skin,
        ] {
            assert_eq!(RampHue::from_slug(h.slug()), Some(h));
        }
        assert!(RampHue::from_slug("nonexistent").is_none());
    }

    #[test]
    fn chroma_ramp_starts_at_the_neutral_axis() {
        // x=0 carries chroma 0 — the Oklab (a, b) collapse to (0, 0), so
        // the Rec.2020 triple must be achromatic (R == G == B).
        let img = chroma_ramp(RampHue::FoliageYellowGreen, 128, 1);
        let p = img.pixels[0];
        assert!(
            (p[0] - p[1]).abs() < 1e-4 && (p[1] - p[2]).abs() < 1e-4,
            "x=0 should be achromatic: {:?}",
            p
        );
    }

    #[test]
    fn chroma_ramp_is_not_uniform() {
        // A real ramp must vary across x — this catches a degenerate
        // generator that emits the same pixel everywhere (which would
        // make the banding detector vacuously pass).
        let img = chroma_ramp(RampHue::Blue, 64, 1);
        let first = img.pixels[0];
        let last = img.pixels[63];
        assert_ne!(first, last, "chroma ramp did not vary across x");
    }

    #[test]
    fn chroma_ramp_rows_are_identical() {
        let img = chroma_ramp(RampHue::Skin, 16, 4);
        let w = 16usize;
        for y in 1..4 {
            for x in 0..w {
                assert_eq!(img.pixels[y * w + x], img.pixels[x]);
            }
        }
    }

    #[test]
    fn chroma_ramp_covers_every_named_hue() {
        // Smoke test: every named hue produces a valid, finite, varying ramp.
        for hue in [
            RampHue::FoliageYellowGreen,
            RampHue::Blue,
            RampHue::Magenta,
            RampHue::Skin,
        ] {
            let img = chroma_ramp(hue, 32, 1);
            for p in &img.pixels {
                for &c in p {
                    assert!(c.is_finite(), "{:?}: non-finite pixel {:?}", hue, p);
                }
            }
            assert_ne!(
                img.pixels[0],
                img.pixels[31],
                "{:?}: ramp did not vary",
                hue
            );
        }
    }
}

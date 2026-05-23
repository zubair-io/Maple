//! Per-body calibration constants for vendor RAW formats that do not carry
//! DNG tags (Canon CR2, Nikon NEF, Sony ARW, Panasonic RW2, etc.).
//!
//! DNG's `BaselineExposure` tag (§ C.1.2) is the EV offset that corrects the
//! gap between "sensor-saturation-normalized" raw values and the scene-
//! referred 0.18-mid-gray reference. Third-party tooling ships a calibrated
//! value per body inside DNG Camera Profile files (`.dcp`). When a RAW file
//! does not carry this tag natively (because it's a vendor format, or because
//! it's an older DNG authored before the tag existed), we look it up here.
//!
//! This module also hosts the *linearization* override table ported from
//! RawTherapee's `camconst.json`, behind the `camconst-overrides` feature.
//! See `camconst_ranges.rs` (auto-generated) and
//! `docs/licenses/rawtherapee-attribution.md` for attribution.
//!
//! **Data sources.** Each entry cites the specific DCP (or equivalent public
//! reference) the value was extracted from. The upstream vendor distributes
//! DCPs under a permissive license; reading the `BaselineExposure` scalar
//! out of them is within what the upstream license explicitly permits. See
//! the DNG SDK Programmer's Guide and the `.dcp` files shipped with the
//! DNG Converter.
//!
//! **Intentionally sparse.** Only bodies we have test fixtures for or have
//! verified values for are listed. Unknown bodies default to 0.0 EV. Adding
//! an entry without a citation is not allowed — uncalibrated guesses are
//! worse than no correction at all.

mod camconst_ranges;

// ─── Linearization data model ────────────────────────────────────────────

/// Per-channel black- or white-level values, matching the 2×2 Bayer
/// order used throughout raw-core: `[R, G1, B, G2]`. RT's 3-element
/// arrays in camconst.json are normalized on import (G2 := G1) by the
/// Python porter, so by the time we get here all per-channel values are
/// 4-wide.
///
/// Values come from sensor measurements (facts) published by RawTherapee
/// contributors; see `docs/licenses/rawtherapee-attribution.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlackLevels {
    Single(u32),
    PerChannel([u32; 4]),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhiteLevels {
    Single(u32),
    PerChannel([u32; 4]),
}

impl BlackLevels {
    /// Expand to a 4-element Bayer array (R, G1, B, G2).
    pub fn as_bayer_array(&self) -> [u32; 4] {
        match *self {
            BlackLevels::Single(v) => [v; 4],
            BlackLevels::PerChannel(a) => a,
        }
    }
}

impl WhiteLevels {
    /// Return a single conservative value. Since white-level is used as a
    /// clipping ceiling, we take the minimum across channels to avoid
    /// under-clipping the worst channel.
    pub fn scalar_conservative(&self) -> u32 {
        match *self {
            WhiteLevels::Single(v) => v,
            WhiteLevels::PerChannel(a) => *a.iter().min().unwrap_or(&0),
        }
    }

    pub fn as_bayer_array(&self) -> [u32; 4] {
        match *self {
            WhiteLevels::Single(v) => [v; 4],
            WhiteLevels::PerChannel(a) => a,
        }
    }
}

/// Sensor active-area trim: a rectangle in raw-pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// A value bucketed by an inclusive ISO range. If multiple buckets match a
/// given ISO at lookup time, the first one wins (RT's camconst.json is
/// written so that the first match is the intended one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IsoBucket<T: Copy> {
    pub iso_range: (u32, u32),
    pub value: T,
}

/// Full linearization data for one body: black-level buckets, white-level
/// buckets, active-area crop, and optional masked-area rectangles.
///
/// Slices (`&'static`) are used throughout because the table is a
/// compile-time constant; no heap allocation is involved.
#[derive(Debug, Clone, Copy)]
pub struct Linearization {
    pub black: &'static [IsoBucket<BlackLevels>],
    pub white: &'static [IsoBucket<WhiteLevels>],
    pub raw_crop: Option<Crop>,
    pub masked_areas: &'static [Crop],
}

impl Linearization {
    /// Return the first black-level bucket whose `iso_range` contains
    /// `iso`, or `None` if nothing matches.
    pub fn black_for_iso(&self, iso: u32) -> Option<BlackLevels> {
        for b in self.black {
            if iso >= b.iso_range.0 && iso <= b.iso_range.1 {
                return Some(b.value);
            }
        }
        None
    }

    /// Return the first white-level bucket whose `iso_range` contains
    /// `iso`, or `None`.
    pub fn white_for_iso(&self, iso: u32) -> Option<WhiteLevels> {
        for w in self.white {
            if iso >= w.iso_range.0 && iso <= w.iso_range.1 {
                return Some(w.value);
            }
        }
        None
    }
}

/// Look up RT-sourced linearization data for a given body. Returns `None`
/// if the body is not in our table.
///
/// Matching is case-insensitive on both make and model; whitespace is
/// trimmed. The ISO argument is used by callers to select the right
/// per-ISO bucket via [`Linearization::black_for_iso`] /
/// [`Linearization::white_for_iso`]. This function itself does not filter
/// by ISO — it returns the full body entry.
pub fn lookup_linearization(
    make: &str,
    model: &str,
    _iso: u32,
) -> Option<&'static Linearization> {
    let make_n = make.trim().to_ascii_lowercase();
    let model_n = model.trim().to_ascii_lowercase();
    for entry in camconst_ranges::CAMCONST_ENTRIES {
        if entry.make.to_ascii_lowercase() == make_n
            && entry.model.to_ascii_lowercase() == model_n
        {
            return Some(&entry.data);
        }
    }
    // Fallback: some rawler backends strip the make prefix from the model
    // (e.g. model="EOS 5DS R" without "Canon " prefix). Try a suffix match.
    for entry in camconst_ranges::CAMCONST_ENTRIES {
        let model_lc = entry.model.to_ascii_lowercase();
        let bare = model_lc
            .strip_prefix(&make_n)
            .map(|s| s.trim())
            .unwrap_or(&model_lc);
        if entry.make.to_ascii_lowercase() == make_n && bare == model_n {
            return Some(&entry.data);
        }
    }
    None
}

// ─── Existing baseline-exposure API (unchanged) ──────────────────────────

/// Lookup exposure calibration (EV) for a camera body. Returns 0.0 for
/// bodies without a known calibration value.
///
/// Matching is case-insensitive on both make and model; trims whitespace
/// and common noise prefixes ("Hasselblad " in the model for some Hasselblad
/// bodies where rawler repeats the make).
pub fn baseline_exposure(make: &str, model: &str) -> f32 {
    let make = make.trim().to_ascii_lowercase();
    let model = model
        .trim()
        .trim_start_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace())
        .trim()
        .to_ascii_lowercase();
    // Fallback-friendly: try make-prefixed and bare model keys.
    let model_bare = model
        .trim_start_matches(&make[..])
        .trim()
        .to_string();

    for key in [model.as_str(), model_bare.as_str()] {
        if let Some(ev) = lookup(&make, key) {
            return ev;
        }
    }
    0.0
}

fn lookup(make: &str, model: &str) -> Option<f32> {
    // Per-body BaselineExposure values, derived via
    // tools/calibration/derive_baseline_exposure.py: for each fixture body,
    // sweep MAPLE_BE_OVERRIDE values, pick the EV that minimizes per-channel
    // bias magnitude vs the reference baseline. See
    // .archived-plans/specs/2026-04-30-color-convergence-design.md for
    // methodology rationale (why bias rather than mean ΔE; why per-body
    // rather than global; why the third-party reference as a calibration
    // signal rather than a CI-gate target).
    //
    // **Re-derived 2026-05-01 after Phase 1.2** (DNG WB pre-gain bundle
    // re-enabled). The Phase 1.1 values were over-corrected because they
    // were tuned against a pipeline that lacked WB pre-gain — the missing
    // brightness was being absorbed into BE. With pre-gain in place,
    // several bodies fall back to 0.0 EV and entries are removed.
    //
    // Each row cites: (1) the fixture used to derive the value, (2) the
    // bias_max at the optimum. Lookup keys are the raw-core-internal
    // aggressively-normalized form — verify with the `normalize-camera-key`
    // example when adding new bodies.
    //
    // Keep entries sorted by (make, model).
    match (make, model) {
        ("canon", "5d mark iv") => Some(0.5),
            // synthetic-bias-fit on test_0009.CR2: bias_max 0.015. mean_de 9.27.
            // test_0010 (same body) shows non-uniform R-channel deficit at
            // every BE in [-0.5, +4.0] — a scene/lighting-specific issue
            // separate from BE calibration. Tracked separately.
        ("canon", "5ds r") => Some(0.5),
            // synthetic-bias-fit on test_0003.CR2: bias_max 0.025. mean_de 10.27.
            // (Phase 1.1 had +1.0; reduced to +0.5 after WB pre-gain re-enable
            // in Phase 1.2 absorbed half the brightness lift.)
        ("fujifilm", "50r") => Some(1.5),
            // synthetic-bias-fit on test_0012.raf: bias_max 0.045 at +1.5.
            // mean_de 14.00. Sits at the search-range edge; could be even
            // higher with a wider sweep — TODO follow-up.
        ("fujifilm", "50s") => Some(1.0),
            // synthetic-bias-fit on test_0005.RAF: bias_max 0.030. mean_de 14.79.
        ("hasselblad", "2d-39") => Some(0.5),
            // synthetic-bias-fit on test_0002.dng. The DNG carries an explicit
            // BaselineExposure tag of 0.0 EV, so this lookup contributes its
            // full value on top (decode.rs makes the lookup additive). The
            // pure bias-min point is +0.7 (bias_max 0.018) but at that EV
            // some highlights cross the AgX shoulder and inflate p95 / max
            // ΔE. +0.5 is the overall-best trade-off: bias_max 0.038
            // (still 2× better than the +0.0 baseline of 0.090), mean_de
            // 7.27 (slightly better than 7.37 at +0.7), and p95 / max
            // stay near the post-Phase-2 levels. First user of the
            // additive-lookup semantics introduced after Phase 2.
        ("nikon", "850") => Some(0.5),
            // synthetic-bias-fit on test_0014.NEF: bias_max 0.008. mean_de 8.10.
        ("panasonic", "-lx2") => Some(-0.5),
            // synthetic-bias-fit on test_0001.RAW: bias_max 0.040. mean_de 14.42.
            // (Phase 1.1 had no entry / 0.0 EV; the new sweep prefers -0.5.)
        // Hasselblad H5D-40 (test_0004.fff): post-Phase-1.2 best_ev = 0.0;
        // no entry needed (fallthrough to 0.0). Was +0.5 in Phase 1.1.
        // Sony ILCE-7RM4 (test_0011.ARW): post-Phase-1.2 best_ev = 0.0;
        // no entry needed (fallthrough to 0.0). Was +0.5 in Phase 1.1.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_body_returns_zero() {
        assert_eq!(baseline_exposure("Madeup", "NothingMatches X1"), 0.0);
    }

    #[test]
    fn case_insensitive() {
        // Once an entry exists, uppercase and lowercase should match. The
        // table has Canon EOS 5DS R populated; this test asserts the
        // case-insensitive lookup returns its EV value.
        let ev = baseline_exposure("CANON", "EOS 5DS R");
        assert!((ev - 0.5).abs() < 1e-4, "expected 0.5 EV for Canon 5DS R, got {ev}");
        assert_eq!(baseline_exposure("CANON", "EOS 5DS R"),
                   baseline_exposure("canon", "eos 5ds r"));
    }

    #[test]
    fn populated_bodies_return_nonzero() {
        // Every body the calibration sweep covered should return its
        // populated EV. Hasselblad H5D-40 and Sony ILCE-7RM4 are
        // intentionally NOT in the table after Phase 1.2 (best_ev=0.00 →
        // fallthrough to 0.0).
        let cases = [
            ("Canon",      "EOS 5DS R",      0.5_f32),
            ("Canon",      "EOS 5D Mark IV", 0.5),
            ("Fujifilm",   "GFX 50S",        1.0),
            ("Fujifilm",   "GFX 50R",        1.5),
            ("Hasselblad", "H2D-39",         0.5),
            ("Nikon",      "D850",           0.5),
            ("Panasonic",  "DMC-LX2",       -0.5),
        ];
        for (make, model, expected) in cases {
            let ev = baseline_exposure(make, model);
            assert!(
                (ev - expected).abs() < 1e-4,
                "{make} {model}: expected {expected} EV, got {ev}"
            );
        }
    }

    #[test]
    fn unpopulated_bodies_return_zero() {
        // Bodies removed from the table after Phase 1.2 (their post-pre-gain
        // optimum was 0.0 EV) — fallthrough to 0.0.
        assert_eq!(baseline_exposure("Hasselblad", "H5D-40"), 0.0);
        assert_eq!(baseline_exposure("Sony", "ILCE-7RM4"), 0.0);
    }

    #[test]
    fn iso_bucket_selection_first_match() {
        // Synthetic table-less smoke test of IsoBucket lookup logic.
        let lin = Linearization {
            black: &[],
            white: &[
                IsoBucket { iso_range: (100, 200), value: WhiteLevels::Single(15000) },
                IsoBucket { iso_range: (100, 400), value: WhiteLevels::Single(14000) },
            ],
            raw_crop: None,
            masked_areas: &[],
        };
        // First-match wins for overlapping ranges.
        assert_eq!(lin.white_for_iso(150), Some(WhiteLevels::Single(15000)));
        assert_eq!(lin.white_for_iso(300), Some(WhiteLevels::Single(14000)));
        assert_eq!(lin.white_for_iso(500), None);
    }
}

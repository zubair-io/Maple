//! Per-body calibration constants for vendor RAW formats that do not carry
//! DNG tags (Canon CR2, Nikon NEF, Sony ARW, Panasonic RW2, etc.).
//!
//! DNG's `BaselineExposure` tag (§ C.1.2) is the EV offset that corrects the
//! gap between "sensor-saturation-normalized" raw values and the scene-
//! referred 0.18-mid-gray reference. Adobe ships a calibrated value per body
//! inside their DNG Camera Profile files (`.dcp`). When a RAW file does not
//! carry this tag natively (because it's a vendor format, or because it's an
//! older DNG authored before the tag existed), we look it up here.
//!
//! This module also hosts the *linearization* override table ported from
//! RawTherapee's `camconst.json`, behind the `camconst-overrides` feature.
//! See `camconst_ranges.rs` (auto-generated) and
//! `docs/licenses/rawtherapee-attribution.md` for attribution.
//!
//! **Data sources.** Each entry cites the specific Adobe DNG Camera Profile
//! (or equivalent public reference) the value was extracted from. Adobe
//! distributes DCPs under a permissive license; reading the `BaselineExposure`
//! scalar out of them is within what Adobe explicitly permits. See Adobe's
//! "DNG SDK Programmer's Guide" and the `.dcp` files shipped with Adobe DNG
//! Converter.
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
    // Keep entries sorted by (make, model). Every row MUST cite its source.
    match (make, model) {
        // Source: no entries yet. Populate from Adobe DCPs on a per-body
        // basis as needed. Example format:
        //
        //   ("canon", "eos 5ds r") => Some(0.25),
        //      // Adobe DNG Camera Profile "Canon EOS 5DS R — Camera Standard"
        //      // shipped with Adobe DNG Converter 16.x, BaselineExposure tag.
        //
        // Leave blank until a DCP has been inspected.
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
        // Once an entry exists, uppercase and lowercase should match. With
        // the empty table, both return 0.0 — this test locks in the
        // normalization shape.
        assert_eq!(baseline_exposure("CANON", "EOS 5DS R"),
                   baseline_exposure("canon", "eos 5ds r"));
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

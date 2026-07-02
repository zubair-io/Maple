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

/// A value bucketed by an inclusive ISO range. If multiple buckets match a
/// given ISO at lookup time, the first one wins (RT's camconst.json is
/// written so that the first match is the intended one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IsoBucket<T: Copy> {
    pub iso_range: (u32, u32),
    pub value: T,
}

/// Full linearization data for one body: black-level buckets and
/// white-level buckets, each bucketed by ISO range.
///
/// Slices (`&'static`) are used throughout because the table is a
/// compile-time constant; no heap allocation is involved.
#[derive(Debug, Clone, Copy)]
pub struct Linearization {
    pub black: &'static [IsoBucket<BlackLevels>],
    pub white: &'static [IsoBucket<WhiteLevels>],
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
pub fn lookup_linearization(make: &str, model: &str, _iso: u32) -> Option<&'static Linearization> {
    let make_n = make.trim().to_ascii_lowercase();
    let model_n = model.trim().to_ascii_lowercase();
    for entry in camconst_ranges::CAMCONST_ENTRIES {
        if entry.make.to_ascii_lowercase() == make_n && entry.model.to_ascii_lowercase() == model_n
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

// ─── (Removed) per-body BaselineExposure lookup ──────────────────────────
//
// A hand-curated `baseline_exposure(make, model)` table used to live here,
// derived per-body to minimise channel-bias vs the reference renderer at
// default sliders. It was removed in #370: per-body aesthetic alignment is
// the wrong layer, and the bundled DCP profile's `BaselineExposureOffset`
// field — parsed in `color::profile_loader::parser` but previously
// ignored — is now wired into `decode.rs` § 1b instead. The follow-up
// global Look LUT (#371) that briefly took over the aesthetic-alignment
// role was retired in #443; color correctness now lives in the
// colorimetry path + view transform, not a per-body or global 1D bridge.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_bucket_selection_first_match() {
        // Synthetic table-less smoke test of IsoBucket lookup logic.
        let lin = Linearization {
            black: &[],
            white: &[
                IsoBucket {
                    iso_range: (100, 200),
                    value: WhiteLevels::Single(15000),
                },
                IsoBucket {
                    iso_range: (100, 400),
                    value: WhiteLevels::Single(14000),
                },
            ],
        };
        // First-match wins for overlapping ranges.
        assert_eq!(lin.white_for_iso(150), Some(WhiteLevels::Single(15000)));
        assert_eq!(lin.white_for_iso(300), Some(WhiteLevels::Single(14000)));
        assert_eq!(lin.white_for_iso(500), None);
    }
}

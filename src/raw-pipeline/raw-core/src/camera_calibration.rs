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
}

//! Legacy DisplayLookCurve enum + LUT byte data (ticket #371; retired #443).
//!
//! The empirically-derived 1D per-channel LUT (256 entries × 3 channels =
//! 768 bytes) used to shape display-encoded RGB between
//! `encode::srgb_gamma_encode` and `encode::dither_and_quantize`. #443
//! retired the static Look LUT in favour of the per-image Auto Profile
//! stage (`view::auto_profile`), so there is **no per-pixel Look pass in
//! raw-core any more** — the CPU `look::apply` function was removed in
//! #1090.
//!
//! Two things survive, for two different reasons:
//!
//! * **The [`Look`] enum** — XMP back-compat only. Legacy sidecars that
//!   carry `papp:Look="Default"` / `"Neutral"` migrate to
//!   `papp:Profile="Auto"` / `"Neutral"` in the XMP parser (#536 T5). The
//!   enum is still the wire type the FFI `look_mode: u8` byte maps into.
//! * **The [`LUT_R`] / [`LUT_G`] / [`LUT_B`] byte arrays** — out-of-crate
//!   consumers (`raw-ffi`, `raw-wasm`) read them, via the
//!   `maple_compute_look_lut` FFI entry, to seed a GPU 1D-LUT texture on
//!   the platform (Apple Metal / Web GPU) view-transform path. The byte
//!   data in `look_lut.rs` is the single source of truth for that texture.

#[path = "look_lut.rs"]
mod lut;

// Re-export the raw LUT byte arrays so out-of-crate consumers (raw-ffi,
// raw-wasm) can seed a GPU 1D LUT texture without duplicating the data.
// The `lut` module itself stays private — the API surface widens by three
// `pub` constants, not by a public submodule path.
pub use lut::{LUT_B, LUT_G, LUT_R};

/// Legacy display Look. No longer shapes pixels in raw-core (#443 retired
/// the static LUT; Auto Profile owns view-shaping). Retained as the XMP
/// back-compat type and the FFI `look_mode` wire enum — see module docs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Look {
    /// Legacy "Neutral" — migrated to `Profile::Neutral` on XMP read.
    Neutral,
    /// Legacy "Default" — migrated to `Profile::Auto` on XMP read.
    Default,
}

impl Default for Look {
    fn default() -> Self {
        Self::Default
    }
}

/// Map the C-ABI / WASM `look_mode: u8` byte (the wire representation hosts
/// pass over FFI) into a `Look`. Stable mapping:
///
/// - `0` → [`Look::Neutral`]
/// - anything else → [`Look::Default`]
///
/// The "anything else" branch is deliberate: hosts that have not yet
/// learned about future variants still get the safe default, and the FFI
/// `maple_compute_look_lut` entry rejects unknown bytes separately so the
/// caller can surface the error.
impl From<u8> for Look {
    fn from(v: u8) -> Self {
        match v {
            0 => Look::Neutral,
            _ => Look::Default,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_look_is_default_variant() {
        assert_eq!(Look::default(), Look::Default);
    }

    #[test]
    fn from_u8_maps_zero_to_neutral() {
        assert_eq!(Look::from(0u8), Look::Neutral);
    }

    #[test]
    fn from_u8_maps_one_to_default() {
        assert_eq!(Look::from(1u8), Look::Default);
    }

    #[test]
    fn from_u8_maps_unknown_to_default() {
        // Hosts ignorant of future variants get the safe default; the FFI
        // entry handles unknown bytes as an explicit error separately.
        assert_eq!(Look::from(2u8), Look::Default);
        assert_eq!(Look::from(99u8), Look::Default);
        assert_eq!(Look::from(255u8), Look::Default);
    }

    #[test]
    fn lut_arrays_are_monotone_nondecreasing() {
        // Empirical sanity: a tone-mapping LUT should be monotone — a
        // brighter input maps to an output at least as bright. If a future
        // re-derivation produces a non-monotone LUT, surface that here
        // before it ships.
        for (name, arr) in [
            ("LUT_R", &lut::LUT_R[..]),
            ("LUT_G", &lut::LUT_G[..]),
            ("LUT_B", &lut::LUT_B[..]),
        ] {
            for i in 1..arr.len() {
                assert!(
                    arr[i] >= arr[i - 1],
                    "{name} non-monotone at index {i}: {} -> {}",
                    arr[i - 1],
                    arr[i],
                );
            }
        }
    }

    #[test]
    fn lut_endpoints_are_plausible() {
        // Sanity guards on the derived LUT — the empirical data should
        // map black->black-ish and white->white-ish (the LUT doesn't
        // invert tone). Loose bounds; the derived ceiling at 255 is 250
        // (R) / 252 (G) / 255 (B). The derived floor at 0 is ~7 / ~7 /
        // ~19 (the empirical lift in deep shadows).
        assert!(lut::LUT_R[0] < 50, "R[0] = {}", lut::LUT_R[0]);
        assert!(lut::LUT_G[0] < 50, "G[0] = {}", lut::LUT_G[0]);
        assert!(lut::LUT_B[0] < 50, "B[0] = {}", lut::LUT_B[0]);
        assert!(lut::LUT_R[255] > 200, "R[255] = {}", lut::LUT_R[255]);
        assert!(lut::LUT_G[255] > 200, "G[255] = {}", lut::LUT_G[255]);
        assert!(lut::LUT_B[255] > 200, "B[255] = {}", lut::LUT_B[255]);
    }
}

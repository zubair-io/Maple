//! UCM (UniqueCameraModel) alias table — maps rawler-reported camera
//! identities to the keys used in the bundled DCP profile set.
//!
//! Why this exists: rawler reports a UCM (or synthesizes a `{make} {model}`
//! key) using vendor naming. The upstream profile authors sometimes use
//! a different naming convention for their DCP files. The bundle's
//! lookup is keyed by the bundle's UCM; without an alias step, fixtures
//! the bundle DOES cover would miss on a string-equality basis.
//! Empirically observed in the test fixture set:
//!
//!   * Hasselblad medium-format: rawler reports `Hasselblad H2D-39`,
//!     `Hasselblad H5D-40` etc.; the bundle ships `Hasselblad 39-Coated`,
//!     `Hasselblad 50-15-Coated5`. Different naming convention, same
//!     sensor.
//!
//!   * DJI Mavic 3 Pro's Hasselblad L3D-100c sensor: rawler reports
//!     `Hasselblad L3D-100c`; the bundle ships under the drone's body
//!     code `DJI FC4382 Mavic3Pro`. The L3D-100c is unique to the
//!     Mavic 3 Pro, so this is a 1:1 mapping.
//!
//!   * Pixel mobile (Pixel 6 Pro etc.): rawler reports the bare body
//!     name (`Google Pixel 6 Pro`); the bundle ships per-lens entries
//!     (`Google Pixel 6 Pro Rear Main Camera`,
//!     `Google Pixel 6 Pro Rear Telephoto Camera`,
//!     `Google Pixel 6 Pro Rear Ultrawide Camera`). Choosing among them
//!     would need EXIF lens metadata that rawler doesn't expose on
//!     mobile RAWs — until then, default to the Rear Main lens (the
//!     most common shot for the Pixel 6 Pro's RAW pipeline).
//!
//! Design principles:
//!   * **Exact-match table only** — no fuzzy matching, no substring
//!     heuristics. Every entry here is justified by a fixture in
//!     `test-fixtures/raws/`, hand-verified against the bundled DCP set.
//!   * **Source-key → bundle-key**. The source key is the
//!     [`profile_loader::camera_key_for`] output for the raw; the
//!     bundle key is the UCM in `profiles.bin`.
//!   * **Side-channel awareness when needed.** The Pixel-style "one
//!     body, many lenses" case can't be resolved by UCM string alone.
//!     The mapping function takes the full [`RawImage`] so a future
//!     iteration can pivot on EXIF lens metadata. For now, defaults
//!     to the most-common lens variant.
//!
//! Scope: this is intentionally a curated table, not a generic
//! similarity engine. Every entry trades coverage for correctness.

use crate::image::RawImage;

/// Map the rawler-reported camera key to the bundle's authoring UCM, if
/// an alias is known. Returns `None` when no alias is needed (or known).
///
/// The caller is [`crate::color::profile_loader::lookup_profile`]:
///   1. Try the source key directly against the bundle.
///   2. On miss, call this; if it returns `Some(alias)`, try that key.
///   3. If both miss, the bundle has no entry for this body — the DCP
///      path returns an identity-fallback profile (#345).
///
/// `_raw` is unused today. It's threaded through so the Pixel-lens
/// future iteration can read EXIF lens metadata without touching every
/// call site again.
pub fn map_to_bundle_ucm(_raw: &RawImage, source_key: &str) -> Option<&'static str> {
    match source_key {
        // ── Hasselblad medium-format ──────────────────────────────────
        // The H-series body codes (H2D, H4D, H5D, H6D) carry the sensor
        // size in their number suffix (-39, -40, -50, -100). The bundle
        // uses sensor-naming (`Hasselblad 39-Coated`, etc.) since the
        // per-sensor calibration is what matters for color, not the
        // body shell. Verified by inspecting the bundled profile set
        // (see `convert_dcps.py` + the bundle parser).
        "Hasselblad H2D-39" => Some("Hasselblad 39-Coated"),
        // ── DJI Mavic 3 Pro (Hasselblad L3D-100c sensor) ──────────────
        // The L3D-100c is the 100 MP main-camera sensor on the Mavic 3
        // Pro. The bundle files it under the drone body code FC4382.
        // The L3D-100c is unique to the Mavic 3 Pro, so this is 1:1.
        // FC4370 is the same sensor on the Mavic 3 Cine variant — we
        // don't map there explicitly because rawler would have to
        // report something other than `Hasselblad L3D-100c` to reach
        // here, and that case doesn't exist in our fixtures.
        "Hasselblad L3D-100c" => Some("DJI FC4382 Mavic3Pro"),
        // ── Google Pixel 6 Pro ────────────────────────────────────────
        // Default to the Rear Main Camera profile. The Pixel 6 Pro's
        // RAW pipeline most often produces output from the main wide
        // sensor; selecting telephoto / ultrawide requires EXIF lens
        // metadata that rawler doesn't surface today. When that lands,
        // the `_raw` arg can be inspected and the variant picked
        // properly. Tracking issue: see COVERAGE.md.
        "Google Pixel 6 Pro" => Some("Google Pixel 6 Pro Rear Main Camera"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{CfaPattern, ExifOrientation};

    fn make_raw(model: &str) -> RawImage {
        RawImage {
            width: 1,
            height: 1,
            cfa: CfaPattern::Rggb,
            black_level: [0; 4],
            white_level: 1,
            raw_data: vec![0],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: model.into(),
            unique_camera_model: Some(model.into()),
            color_matrices: Default::default(),
            forward_matrices: Default::default(),
            orientation: ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data: std::collections::HashMap::new(),
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
            crop_rect: None,
            iso: 100,
            noise_profile: None,
            opcode_list3: None,
            aperture: None,
            focal_length: None,
        }
    }

    #[test]
    fn hasselblad_h2d_39_aliases_to_39_coated() {
        let raw = make_raw("Hasselblad H2D-39");
        assert_eq!(
            map_to_bundle_ucm(&raw, "Hasselblad H2D-39"),
            Some("Hasselblad 39-Coated")
        );
    }

    #[test]
    fn hasselblad_l3d_100c_aliases_to_dji_fc4382() {
        let raw = make_raw("Hasselblad L3D-100c");
        assert_eq!(
            map_to_bundle_ucm(&raw, "Hasselblad L3D-100c"),
            Some("DJI FC4382 Mavic3Pro")
        );
    }

    #[test]
    fn pixel_6_pro_aliases_to_rear_main_camera() {
        let raw = make_raw("Google Pixel 6 Pro");
        assert_eq!(
            map_to_bundle_ucm(&raw, "Google Pixel 6 Pro"),
            Some("Google Pixel 6 Pro Rear Main Camera")
        );
    }

    #[test]
    fn unknown_key_returns_none() {
        let raw = make_raw("Made-Up Camera Model");
        assert_eq!(map_to_bundle_ucm(&raw, "Made-Up Camera Model"), None);
    }

    /// Native-UCM keys that the bundle already covers byte-for-byte must
    /// NOT be aliased — going through the alias table would either
    /// silently re-map a covered body or (in the worst case) point a
    /// covered body at a wrong DCP. The mapping is a fallback for the
    /// MISS case only.
    #[test]
    fn already_covered_ucms_have_no_alias() {
        let raw = make_raw("Canon EOS 5D Mark IV");
        assert_eq!(map_to_bundle_ucm(&raw, "Canon EOS 5D Mark IV"), None);
        let raw = make_raw("Nikon D850");
        assert_eq!(map_to_bundle_ucm(&raw, "Nikon D850"), None);
        let raw = make_raw("LEICA M10");
        assert_eq!(map_to_bundle_ucm(&raw, "LEICA M10"), None);
    }
}

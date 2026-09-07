//! The Detail group's decode-product schema entries — the three `papp:`
//! stages Maple owns (#1104 / #1105 / #1106), the four DNG lens-correction
//! scales ACR namespaces under `crs:LensProfile*` (#376), and the Bayer
//! demosaic override (#3413).
//!
//! Split out of `schema/mod.rs` (#3413) to stay under CONTRIBUTING.md's 570-line
//! headroom budget, the same sibling-module pattern `hsl.rs` (#366),
//! `color_grade.rs` (#376), `display_curves.rs` (#2232) and
//! `perspective.rs` (#3410) already follow. `ADJUSTMENT_SCHEMA` lists these
//! consts in place, so the emitted field ORDER — which the C ABI and every
//! generated mirror depend on — is unchanged by the move.
//!
//! What the seven have in common, and why they travel together: each is
//! baked into the Rust decode product rather than re-applied by a per-tick
//! GPU stage, so each belongs to the same decoded-image cache-key family
//! and each costs a full re-decode to change.

use super::{FieldKind, FieldSpec};

pub(super) const CHROMA_PREFILTER: FieldSpec = FieldSpec {
        name: "chroma_prefilter",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Decode-time chroma pre-filter strength (#1104, tone/zoom design spec § 3.1). Luma-guided sparse cross-bilateral on opponent chroma inside the decode product; 0 (default) skips the stage bit-identically. XMP key `papp:ChromaPrefilter`. Part of the decoded-image cache key.",
    };

pub(super) const HOT_PIXEL_SUPPRESSION: FieldSpec = FieldSpec {
        name: "hot_pixel_suppression",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "HotPixelSuppressionMode",
        doc: "Hot/dead-pixel suppression (#1106, tone/zoom design spec § 10.6). Pre-demosaic same-color-neighbor outlier replacement inside the decode product; 'Off' (default) skips the stage bit-identically. XMP key `papp:HotPixelSuppression`. Part of the decoded-image cache key.",
    };

pub(super) const DEEP_DENOISE: FieldSpec = FieldSpec {
        name: "deep_denoise",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "BM3D deep denoise strength (#1105, tone/zoom design spec § 3.2). Two-stage collaborative filtering, input-referred inside the decode product; 0 (default) skips the stage bit-identically. XMP key `papp:DeepDenoise`. Part of the decoded-image cache key.",
    };

pub(super) const LENS_PROFILE_ENABLE: FieldSpec = FieldSpec {
        name: "lens_profile_enable",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "LensProfileEnable",
        doc: "Master on/off for the lens corrections a DNG embeds in its OpcodeList3 (#376). 'On' (default) applies each family at its own scale, matching ACR's behaviour when a profile is present; 'Off' overrides all three scales. XMP key `crs:LensProfileEnable`.",
    };

pub(super) const LENS_CORRECTION_DISTORTION: FieldSpec = FieldSpec {
        name: "lens_correction_distortion",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 100.0,
        enum_name: "",
        doc: "Geometric-distortion correction strength (#376) — the DNG `WarpRectilinear` component common to all three planes. 100 (default) applies the vendor's authored warp in full; 0 leaves the frame undistorted-as-shot. XMP key `crs:LensProfileDistortionScale`. Part of the decoded-image cache key.",
    };

pub(super) const LENS_CORRECTION_CA: FieldSpec = FieldSpec {
        name: "lens_correction_ca",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 100.0,
        enum_name: "",
        doc: "Lateral chromatic-aberration correction strength (#376) — each plane's DNG `WarpRectilinear` deviation from the green reference plane. Has no effect on a DNG carrying a single coefficient set (no CA encoded). XMP key `crs:LensProfileChromaticAberrationScale`. Part of the decoded-image cache key.",
    };

pub(super) const LENS_CORRECTION_VIGNETTING: FieldSpec = FieldSpec {
        name: "lens_correction_vignetting",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 100.0,
        enum_name: "",
        doc: "Vignetting / lens-shading correction strength (#376) — the DNG `FixVignetteRadial` and `GainMap` gain opcodes. XMP key `crs:LensProfileVignettingScale`. Part of the decoded-image cache key.",
    };

pub(super) const DEMOSAIC: FieldSpec = FieldSpec {
        name: "demosaic",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "DemosaicChoice",
        doc: "Bayer demosaic kernel override (#3413). 'Auto' (default) picks from the frame's noise profile and size — LMMSE when noisy, the AMaZE+VNG4 dual on a large clean frame, AMaZE alone on a small one; every other value pins one kernel. Inert on the binned fit-view path and on non-Bayer sources. XMP key `papp:Demosaic`. Part of the decoded-image cache key.",
    };

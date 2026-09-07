//! The seven profile-free lens-correction schema entries (#3411) — the
//! `auto_lateral_ca` toggle plus ACR's six `Defringe*` controls.
//!
//! A sibling submodule of `schema/mod.rs` for the same reason `hsl`,
//! `color_grade`, and `display_curves` are: spelling all seven `FieldSpec`
//! literals inline pushed that file past the 600-LOC hard budget (#1181).
//! `ADJUSTMENT_SCHEMA` lists them in place, so the emitted order still
//! matches `AdjustmentModel`'s struct order.

use super::types::{FieldKind, FieldSpec};

pub(super) const AUTO_LATERAL_CA: FieldSpec = FieldSpec {
    name: "auto_lateral_ca",
    kind: FieldKind::Enum,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "AutoLateralCa",
    doc: "Profile-free lateral chromatic-aberration correction (#3411). 'On' estimates the radial R/B-vs-G displacement from the mosaic itself and resamples both planes before demosaic; 'Off' (default, matching ACR's unticked 'Remove Chromatic Aberration') skips the stage bit-identically. Self-skips on a RAW whose OpcodeList3 already carries per-plane WarpRectilinear coefficients. XMP key `crs:AutoLateralCA`. Part of the decoded-image cache key.",
};

pub(super) const DEFRINGE_PURPLE_AMOUNT: FieldSpec = FieldSpec {
    name: "defringe_purple_amount",
    kind: FieldKind::F32,
    range: (0.0, 20.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Purple-fringe suppression strength (#3411), ACR's Defringe amount. Desaturates in-band chroma next to high-contrast edges in scene-linear Oklab; 0 (default) skips the stage bit-identically. XMP key `crs:DefringePurpleAmount`.",
};

pub(super) const DEFRINGE_PURPLE_HUE_LO: FieldSpec = FieldSpec {
    name: "defringe_purple_hue_lo",
    kind: FieldKind::F32,
    range: (0.0, 100.0),
    default_f32: 30.0,
    enum_name: "",
    doc: "Low edge of the purple hue band on ACR's [0, 100] defringe-hue axis (#3411). Inert while `defringe_purple_amount` is 0. XMP key `crs:DefringePurpleHueLo`.",
};

pub(super) const DEFRINGE_PURPLE_HUE_HI: FieldSpec = FieldSpec {
    name: "defringe_purple_hue_hi",
    kind: FieldKind::F32,
    range: (0.0, 100.0),
    default_f32: 70.0,
    enum_name: "",
    doc: "High edge of the purple hue band (#3411). XMP key `crs:DefringePurpleHueHi`.",
};

pub(super) const DEFRINGE_GREEN_AMOUNT: FieldSpec = FieldSpec {
    name: "defringe_green_amount",
    kind: FieldKind::F32,
    range: (0.0, 20.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Green-fringe suppression strength (#3411), ACR's Defringe amount for the green family. 0 (default) skips the stage bit-identically. XMP key `crs:DefringeGreenAmount`.",
};

pub(super) const DEFRINGE_GREEN_HUE_LO: FieldSpec = FieldSpec {
    name: "defringe_green_hue_lo",
    kind: FieldKind::F32,
    range: (0.0, 100.0),
    default_f32: 40.0,
    enum_name: "",
    doc: "Low edge of the green hue band on ACR's [0, 100] defringe-hue axis (#3411). Inert while `defringe_green_amount` is 0. XMP key `crs:DefringeGreenHueLo`.",
};

pub(super) const DEFRINGE_GREEN_HUE_HI: FieldSpec = FieldSpec {
    name: "defringe_green_hue_hi",
    kind: FieldKind::F32,
    range: (0.0, 100.0),
    default_f32: 60.0,
    enum_name: "",
    doc: "High edge of the green hue band (#3411). XMP key `crs:DefringeGreenHueHi`.",
};

//! White-balance schema entries: the slider pair and method (moved out of
//! `mod.rs` for the 600-LOC budget) plus the #2434 provenance fields.
//! `ADJUSTMENT_SCHEMA` lists them in place so emitted order still matches
//! the struct.
//!
//! The provenance fields are metadata, not render inputs — `wb_source`
//! rides the WhiteBalance copy group (a pasted Preset/Manual state should
//! say so), while the sample coordinates and algorithm version are
//! `NON_COPYABLE_FIELDS`: they describe THIS image's pixels and THIS
//! derivation, not a look.

use super::{FieldKind, FieldSpec};

pub(super) const TEMPERATURE: FieldSpec = FieldSpec {
    name: "temperature",
    kind: FieldKind::F32,
    range: (2000.0, 12000.0),
    default_f32: 6500.0,
    enum_name: "",
    doc: "White balance correlated color temperature in Kelvin.",
};
pub(super) const TINT: FieldSpec = FieldSpec {
    name: "tint",
    kind: FieldKind::F32,
    range: (-150.0, 150.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "White balance green/magenta tint. Range matches ACR's crs:Tint span (#1870).",
};
pub(super) const WB_METHOD: FieldSpec = FieldSpec {
    name: "wb_method",
    kind: FieldKind::Enum,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "WbMethod",
    doc: "User white-balance method (ticket #431). 'Cat16' performs proper chromatic adaptation in CAT16 cone space (default); 'DiagonalRec2020' is the legacy per-channel diagonal-gain path retained for parity A/B.",
};

pub(super) const WB_SOURCE: FieldSpec = FieldSpec {
    name: "wb_source",
    kind: FieldKind::Enum,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "WbSource",
    doc: "Where the white balance came from (#2434): 'AsShot' (default), 'Auto', 'Preset', 'Sampled', or 'Manual'. XMP key `papp:WbSource`, omitted at the default. Provenance only — never a render input.",
};

pub(super) const WB_SAMPLE_X: FieldSpec = FieldSpec {
    name: "wb_sample_x",
    kind: FieldKind::F32,
    range: (0.0, 1.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Normalised image-relative x of the neutral the white balance was sampled at (#2434); meaningful only when `wb_source` is 'Sampled'. XMP key `papp:WbSampleX`.",
};

pub(super) const WB_SAMPLE_Y: FieldSpec = FieldSpec {
    name: "wb_sample_y",
    kind: FieldKind::F32,
    range: (0.0, 1.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Normalised image-relative y of the neutral the white balance was sampled at (#2434); meaningful only when `wb_source` is 'Sampled'. XMP key `papp:WbSampleY`.",
};

pub(super) const WB_ALGORITHM_VERSION: FieldSpec = FieldSpec {
    name: "wb_algorithm_version",
    kind: FieldKind::F32,
    range: (0.0, 1000000.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Version of the estimator that produced an 'Auto' or 'Sampled' white balance (#2434; `raw_core::stages::white_balance_sample::WB_ALGORITHM_VERSION`), 0 when the pair was not derived. A re-derivation of the math bumps it so an old sidecar's stored reading is never reinterpreted. XMP key `papp:WbAlgorithmVersion`.",
};

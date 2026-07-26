//! Colour Grading schema entries (#275, formerly #1111) — the five
//! `split_tone_*` fields plus the eight `color_grade_*` wheels, split out
//! of `schema/mod.rs` in #376 to keep that file under the 600-LOC hard
//! budget. Same shape as the sibling `hsl.rs`: `ADJUSTMENT_SCHEMA` lists
//! these consts in place, so schema order still matches struct order and
//! every codegen output stays byte-identical.

use super::{FieldKind, FieldSpec};

pub(super) const SPLIT_TONE_SHADOW_HUE: FieldSpec = FieldSpec {
    name: "split_tone_shadow_hue",
    kind: FieldKind::F32,
    range: (0.0, 360.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Split-tone shadow hue in degrees (#1111, tone/zoom design spec § 10.3) — display-linear Oklab tint.",
};

pub(super) const SPLIT_TONE_SHADOW_SATURATION: FieldSpec = FieldSpec {
    name: "split_tone_shadow_saturation",
    kind: FieldKind::F32,
    range: (0.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Split-tone shadow saturation (#1111); 0 disables the shadow tint.",
};

pub(super) const SPLIT_TONE_HIGHLIGHT_HUE: FieldSpec = FieldSpec {
    name: "split_tone_highlight_hue",
    kind: FieldKind::F32,
    range: (0.0, 360.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Split-tone highlight hue in degrees (#1111).",
};

pub(super) const SPLIT_TONE_HIGHLIGHT_SATURATION: FieldSpec = FieldSpec {
    name: "split_tone_highlight_saturation",
    kind: FieldKind::F32,
    range: (0.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Split-tone highlight saturation (#1111); 0 disables the highlight tint.",
};

pub(super) const SPLIT_TONE_BALANCE: FieldSpec = FieldSpec {
    name: "split_tone_balance",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Colour-grading balance — warps the tonal axis via a Yd^exp2(-bal/100) remap, shifting the shadow/midtone/highlight crossovers (#275, formerly #1111). Primary drag-bar field for the Color Grading tool. XMP: crs:SplitToningBalance.",
};

// Colour grading (#275) — the wheels ACR namespaces under
// `crs:ColorGrade*`. Shadow/highlight hue+sat and balance are the five
// `split_tone_*` fields above, matching ACR's own layout.

pub(super) const COLOR_GRADE_SHADOW_LUMINANCE: FieldSpec = FieldSpec {
    name: "color_grade_shadow_luminance",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Colour-grading shadow luminance offset (#275). XMP: crs:ColorGradeShadowLum.",
};

pub(super) const COLOR_GRADE_MIDTONE_HUE: FieldSpec = FieldSpec {
    name: "color_grade_midtone_hue",
    kind: FieldKind::F32,
    range: (0.0, 360.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Colour-grading midtone hue in degrees (#275). XMP: crs:ColorGradeMidtoneHue.",
};

pub(super) const COLOR_GRADE_MIDTONE_SATURATION: FieldSpec = FieldSpec {
    name: "color_grade_midtone_saturation",
    kind: FieldKind::F32,
    range: (0.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Colour-grading midtone saturation (#275); 0 disables the midtone tint. XMP: crs:ColorGradeMidtoneSat.",
};

pub(super) const COLOR_GRADE_MIDTONE_LUMINANCE: FieldSpec = FieldSpec {
    name: "color_grade_midtone_luminance",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Colour-grading midtone luminance offset (#275). XMP: crs:ColorGradeMidtoneLum.",
};

pub(super) const COLOR_GRADE_HIGHLIGHT_LUMINANCE: FieldSpec = FieldSpec {
    name: "color_grade_highlight_luminance",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Colour-grading highlight luminance offset (#275). XMP: crs:ColorGradeHighlightLum.",
};

pub(super) const COLOR_GRADE_GLOBAL_HUE: FieldSpec = FieldSpec {
    name: "color_grade_global_hue",
    kind: FieldKind::F32,
    range: (0.0, 360.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Colour-grading global hue in degrees (#275) — the unweighted wheel that tints every tone. XMP: crs:ColorGradeGlobalHue.",
};

pub(super) const COLOR_GRADE_GLOBAL_SATURATION: FieldSpec = FieldSpec {
    name: "color_grade_global_saturation",
    kind: FieldKind::F32,
    range: (0.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Colour-grading global saturation (#275); 0 disables the global tint. XMP: crs:ColorGradeGlobalSat.",
};

pub(super) const COLOR_GRADE_GLOBAL_LUMINANCE: FieldSpec = FieldSpec {
    name: "color_grade_global_luminance",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Colour-grading global luminance offset (#275). XMP: crs:ColorGradeGlobalLum.",
};

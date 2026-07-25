//! HSL 8-band hue / saturation / luminance schema entries (#1112,
//! tone/zoom design spec § 10.4) — 24 `crs:`-compatible scalars split out
//! of `schema/mod.rs` to keep that file under the 600-LOC hard budget
//! (#366). Band order: Red, Orange, Yellow, Green, Aqua, Blue, Purple,
//! Magenta; all range -100..100, default 0. `ADJUSTMENT_SCHEMA` lists
//! these consts in place, so schema order still matches struct order.

use super::{FieldKind, FieldSpec};

pub(super) const HUE_ADJUSTMENT_RED: FieldSpec = FieldSpec {
    name: "hue_adjustment_red",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Red hue adjustment (#1112, tone/zoom design spec § 10.4). Oklab hue rotation on the Red band; ±100 ↔ ±30° (pending ACR calibration). XMP: crs:HueAdjustmentRed.",
};

pub(super) const HUE_ADJUSTMENT_ORANGE: FieldSpec = FieldSpec {
    name: "hue_adjustment_orange",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Orange hue adjustment (#1112). XMP: crs:HueAdjustmentOrange.",
};

pub(super) const HUE_ADJUSTMENT_YELLOW: FieldSpec = FieldSpec {
    name: "hue_adjustment_yellow",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Yellow hue adjustment (#1112). XMP: crs:HueAdjustmentYellow.",
};

pub(super) const HUE_ADJUSTMENT_GREEN: FieldSpec = FieldSpec {
    name: "hue_adjustment_green",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Green hue adjustment (#1112). XMP: crs:HueAdjustmentGreen.",
};

pub(super) const HUE_ADJUSTMENT_AQUA: FieldSpec = FieldSpec {
    name: "hue_adjustment_aqua",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Aqua hue adjustment (#1112). XMP: crs:HueAdjustmentAqua.",
};

pub(super) const HUE_ADJUSTMENT_BLUE: FieldSpec = FieldSpec {
    name: "hue_adjustment_blue",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Blue hue adjustment (#1112). XMP: crs:HueAdjustmentBlue.",
};

pub(super) const HUE_ADJUSTMENT_PURPLE: FieldSpec = FieldSpec {
    name: "hue_adjustment_purple",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Purple hue adjustment (#1112). XMP: crs:HueAdjustmentPurple.",
};

pub(super) const HUE_ADJUSTMENT_MAGENTA: FieldSpec = FieldSpec {
    name: "hue_adjustment_magenta",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Magenta hue adjustment (#1112). XMP: crs:HueAdjustmentMagenta.",
};

pub(super) const SATURATION_ADJUSTMENT_RED: FieldSpec = FieldSpec {
    name: "saturation_adjustment_red",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Red saturation adjustment (#1112). Scales Oklab chroma on the Red band; ±100 ↔ scale ×2 / ×0. XMP: crs:SaturationAdjustmentRed.",
};

pub(super) const SATURATION_ADJUSTMENT_ORANGE: FieldSpec = FieldSpec {
    name: "saturation_adjustment_orange",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Orange saturation adjustment (#1112). XMP: crs:SaturationAdjustmentOrange.",
};

pub(super) const SATURATION_ADJUSTMENT_YELLOW: FieldSpec = FieldSpec {
    name: "saturation_adjustment_yellow",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Yellow saturation adjustment (#1112). XMP: crs:SaturationAdjustmentYellow.",
};

pub(super) const SATURATION_ADJUSTMENT_GREEN: FieldSpec = FieldSpec {
    name: "saturation_adjustment_green",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Green saturation adjustment (#1112). XMP: crs:SaturationAdjustmentGreen.",
};

pub(super) const SATURATION_ADJUSTMENT_AQUA: FieldSpec = FieldSpec {
    name: "saturation_adjustment_aqua",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Aqua saturation adjustment (#1112). XMP: crs:SaturationAdjustmentAqua.",
};

pub(super) const SATURATION_ADJUSTMENT_BLUE: FieldSpec = FieldSpec {
    name: "saturation_adjustment_blue",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Blue saturation adjustment (#1112). XMP: crs:SaturationAdjustmentBlue.",
};

pub(super) const SATURATION_ADJUSTMENT_PURPLE: FieldSpec = FieldSpec {
    name: "saturation_adjustment_purple",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Purple saturation adjustment (#1112). XMP: crs:SaturationAdjustmentPurple.",
};

pub(super) const SATURATION_ADJUSTMENT_MAGENTA: FieldSpec = FieldSpec {
    name: "saturation_adjustment_magenta",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Magenta saturation adjustment (#1112). XMP: crs:SaturationAdjustmentMagenta.",
};

pub(super) const LUMINANCE_ADJUSTMENT_RED: FieldSpec = FieldSpec {
    name: "luminance_adjustment_red",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Red luminance adjustment (#1112). Scales Oklab L on the Red band; ±100 ↔ scale ×2 / ×0. XMP: crs:LuminanceAdjustmentRed.",
};

pub(super) const LUMINANCE_ADJUSTMENT_ORANGE: FieldSpec = FieldSpec {
    name: "luminance_adjustment_orange",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Orange luminance adjustment (#1112). XMP: crs:LuminanceAdjustmentOrange.",
};

pub(super) const LUMINANCE_ADJUSTMENT_YELLOW: FieldSpec = FieldSpec {
    name: "luminance_adjustment_yellow",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Yellow luminance adjustment (#1112). XMP: crs:LuminanceAdjustmentYellow.",
};

pub(super) const LUMINANCE_ADJUSTMENT_GREEN: FieldSpec = FieldSpec {
    name: "luminance_adjustment_green",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Green luminance adjustment (#1112). XMP: crs:LuminanceAdjustmentGreen.",
};

pub(super) const LUMINANCE_ADJUSTMENT_AQUA: FieldSpec = FieldSpec {
    name: "luminance_adjustment_aqua",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Aqua luminance adjustment (#1112). XMP: crs:LuminanceAdjustmentAqua.",
};

pub(super) const LUMINANCE_ADJUSTMENT_BLUE: FieldSpec = FieldSpec {
    name: "luminance_adjustment_blue",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Blue luminance adjustment (#1112). XMP: crs:LuminanceAdjustmentBlue.",
};

pub(super) const LUMINANCE_ADJUSTMENT_PURPLE: FieldSpec = FieldSpec {
    name: "luminance_adjustment_purple",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Purple luminance adjustment (#1112). XMP: crs:LuminanceAdjustmentPurple.",
};

pub(super) const LUMINANCE_ADJUSTMENT_MAGENTA: FieldSpec = FieldSpec {
    name: "luminance_adjustment_magenta",
    kind: FieldKind::F32,
    range: (-100.0, 100.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "HSL Magenta luminance adjustment (#1112). XMP: crs:LuminanceAdjustmentMagenta.",
};

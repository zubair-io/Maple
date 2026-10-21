//! Oklab secondary color-curve schema entries (#5041) — `papp:ColorCurve*`,
//! split out of `schema/mod.rs` to keep that file under the 570-line headroom
//! budget (CONTRIBUTING.md). Applied pre-AgX in scene-linear Oklab immediately
//! after `stages::hsl` by `stages::color_curves`.

use super::{FieldKind, FieldSpec};

pub(super) const COLOR_CURVE_HUE_VS_HUE: FieldSpec = FieldSpec {
    name: "color_curve_hue_vs_hue",
    kind: FieldKind::ToneCurve,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Oklab Hue vs Hue secondary curve (#5041, `papp:ColorCurveHueVsHue`). Periodic over [0, 1); y = 0.5 is neutral (0 deg shift, full range +/-60 deg). Identity (empty) by default.",
};

pub(super) const COLOR_CURVE_HUE_VS_SAT: FieldSpec = FieldSpec {
    name: "color_curve_hue_vs_sat",
    kind: FieldKind::ToneCurve,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Oklab Hue vs Sat secondary curve (#5041, `papp:ColorCurveHueVsSat`). Periodic over [0, 1); y = 0.5 is neutral (1x chroma, full range [0x, 2x]). Identity (empty) by default.",
};

pub(super) const COLOR_CURVE_HUE_VS_LUMA: FieldSpec = FieldSpec {
    name: "color_curve_hue_vs_luma",
    kind: FieldKind::ToneCurve,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Oklab Hue vs Luma secondary curve (#5041, `papp:ColorCurveHueVsLuma`). Periodic over [0, 1); y = 0.5 is neutral (1x L, full range [0.7x, 1.3x]). Identity (empty) by default.",
};

pub(super) const COLOR_CURVE_LUMA_VS_SAT: FieldSpec = FieldSpec {
    name: "color_curve_luma_vs_sat",
    kind: FieldKind::ToneCurve,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Oklab Luma vs Sat secondary curve (#5041, `papp:ColorCurveLumaVsSat`). Scene-referred log-EV lightness axis; y = 0.5 is neutral (1x chroma, full range [0x, 2x]). Identity (empty) by default.",
};

pub(super) const COLOR_CURVE_SAT_VS_SAT: FieldSpec = FieldSpec {
    name: "color_curve_sat_vs_sat",
    kind: FieldKind::ToneCurve,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Oklab Sat vs Sat secondary curve (#5041, `papp:ColorCurveSatVsSat`). Normalized Oklab chroma axis (C / 0.32); y = 0.5 is neutral (1x chroma, full range [0x, 2x]). Identity (empty) by default.",
};

pub(super) const COLOR_CURVE_SAT_VS_LUMA: FieldSpec = FieldSpec {
    name: "color_curve_sat_vs_luma",
    kind: FieldKind::ToneCurve,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Oklab Sat vs Luma secondary curve (#5041, `papp:ColorCurveSatVsLuma`). Normalized Oklab chroma axis (C / 0.32); y = 0.5 is neutral (1x L, full range [0.7x, 1.3x]). Identity (empty) by default.",
};

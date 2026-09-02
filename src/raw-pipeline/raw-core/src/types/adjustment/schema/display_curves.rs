//! Display-referred point-curve schema entries (#2232) — Adobe's
//! `crs:ToneCurvePV2012*`, split out of `schema/mod.rs` to keep that file
//! under the 570-line headroom budget (CONTRIBUTING.md). Applied POST-AgX
//! in display-linear `[0, 1]` by `stages::display_tone_curve`,
//! independently of the scene-linear `tone_curve_*` family (`schema/mod.rs`
//! itself). `ADJUSTMENT_SCHEMA` lists these consts in place, so schema
//! order still matches struct order.

use super::{FieldKind, FieldSpec};

pub(super) const DISPLAY_TONE_CURVE_LUMA: FieldSpec = FieldSpec {
    name: "display_tone_curve_luma",
    kind: FieldKind::ToneCurve,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Display-referred master point curve (#2232, `crs:ToneCurvePV2012`). Applied post-AgX to R/G/B independently with the same curve function (matches Adobe Camera Raw's own point-curve behavior — not luma-coupled). Identity (empty) by default.",
};

pub(super) const DISPLAY_TONE_CURVE_RED: FieldSpec = FieldSpec {
    name: "display_tone_curve_red",
    kind: FieldKind::ToneCurve,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Display-referred red-channel point curve (#2232, `crs:ToneCurvePV2012Red`). Applied post-AgX, independently per channel. Identity (empty) by default.",
};

pub(super) const DISPLAY_TONE_CURVE_GREEN: FieldSpec = FieldSpec {
    name: "display_tone_curve_green",
    kind: FieldKind::ToneCurve,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Display-referred green-channel point curve (#2232, `crs:ToneCurvePV2012Green`). Applied post-AgX, independently per channel. Identity (empty) by default.",
};

pub(super) const DISPLAY_TONE_CURVE_BLUE: FieldSpec = FieldSpec {
    name: "display_tone_curve_blue",
    kind: FieldKind::ToneCurve,
    range: (0.0, 0.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Display-referred blue-channel point curve (#2232, `crs:ToneCurvePV2012Blue`). Applied post-AgX, independently per channel. Identity (empty) by default.",
};

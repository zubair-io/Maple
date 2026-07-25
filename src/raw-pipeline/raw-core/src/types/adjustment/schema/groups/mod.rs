//! Copy / paste / sync adjustment **groups** (ticket #944).
//!
//! Selective paste lets the user copy a subset of one image's edit onto
//! others. The subset unit is a *group* — a named bundle of
//! [`AdjustmentModel`](super::super::AdjustmentModel) fields such as "Tone"
//! or "Detail".
//!
//! This table is the single source of truth for the group → field mapping.
//! `tools/codegen.sh` emits it to Swift (`AdjustmentModel+Generated.swift`)
//! and TypeScript (`adjustment-model.generated.ts`), so Apple and Web cannot
//! drift on group identity, group labels, or group membership.
//!
//! ## Coverage contract
//!
//! Every field on `AdjustmentModel` is either
//!
//! * assigned to exactly one group here (so it participates in copy/paste), or
//! * listed in [`NON_COPYABLE_FIELDS`] with a documented reason.
//!
//! `super::tests` enforces both halves: no field may be missing from both
//! lists, and no field may appear twice. That is what stops a newly-added
//! slider from being silently dropped by paste.
//!
//! ## Mask semantics (#944, decided against the #280 implementation)
//!
//! The local-adjustment foundation (#280) ships two mask shapes,
//! `Mask::Linear` and `Mask::Radial`. Both are **purely parametric** and
//! store their geometry in normalized `[0, 1]` coordinates
//! (`types::local_adjustment`), so a layer re-evaluates correctly against a
//! target image of any pixel dimensions — nothing about them is tied to the
//! source image's raster. There is no brush, AI-subject, or range mask in the
//! model yet.
//!
//! `local_adjustments` is nonetheless in [`NON_COPYABLE_FIELDS`] today for a
//! reason that has nothing to do with mask math: **neither front-end
//! `AdjustmentModel` carries the field**. Swift's
//! `MapleCore.AdjustmentModel` and the TypeScript `AdjustmentModel` both stop
//! at the flat scalar/enum surface plus `crop`; local adjustments exist only
//! in raw-core and the Apple FFI bridge. A "Masks" group would therefore be a
//! checkbox that provably does nothing on both platforms. When either
//! front-end model gains the field, the fix is to move `"local_adjustments"`
//! out of `NON_COPYABLE_FIELDS` into a `Masks` group here — the coverage test
//! makes that a deliberate, reviewed edit rather than an accident.
//!
//! `inpaint_removals` (#1486) is excluded **permanently**, not pending: each
//! `Removal` carries a content-hash reference to a synthetic-raw patch baked
//! from *that image's* pixels (`.maple/inpaint/<patch_ref>.f16`). The metadata
//! is raster-derived and describes nothing about any other image.

/// A user-selectable bundle of `AdjustmentModel` fields for copy / paste /
/// sync (#944).
///
/// Declaration order is the order the groups are presented in the
/// selective-paste UI on both platforms.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AdjustmentGroup {
    /// Temperature / tint plus the interpretation state that makes those two
    /// numbers mean the same thing on the target image.
    WhiteBalance,
    /// Scene tone controls, the PV2012 parametric curve, and the point curves.
    Tone,
    /// Saturation, vibrance, the 24 HSL bands, split toning, and the
    /// render-shaping enums.
    Color,
    /// Sharpening, noise reduction, presence, dehaze, and the decode-product
    /// detail stages.
    Detail,
    /// Vignette and grain.
    Effects,
    /// Crop rect + straighten angle.
    Geometry,
}

impl AdjustmentGroup {
    /// Every group, in presentation order.
    pub const ALL: &'static [AdjustmentGroup] = &[
        AdjustmentGroup::WhiteBalance,
        AdjustmentGroup::Tone,
        AdjustmentGroup::Color,
        AdjustmentGroup::Detail,
        AdjustmentGroup::Effects,
        AdjustmentGroup::Geometry,
    ];

    /// Stable snake_case identifier. Doubles as the storage / wire key so the
    /// two front-ends agree on what a persisted group selection means.
    pub const fn id(self) -> &'static str {
        match self {
            AdjustmentGroup::WhiteBalance => "white_balance",
            AdjustmentGroup::Tone => "tone",
            AdjustmentGroup::Color => "color",
            AdjustmentGroup::Detail => "detail",
            AdjustmentGroup::Effects => "effects",
            AdjustmentGroup::Geometry => "geometry",
        }
    }

    /// Human-readable label for the selective-paste UI. Single-sourced so
    /// Apple and Web show the same words.
    pub const fn label(self) -> &'static str {
        match self {
            AdjustmentGroup::WhiteBalance => "White Balance",
            AdjustmentGroup::Tone => "Tone",
            AdjustmentGroup::Color => "Color",
            AdjustmentGroup::Detail => "Detail",
            AdjustmentGroup::Effects => "Effects",
            AdjustmentGroup::Geometry => "Geometry",
        }
    }

    /// The `AdjustmentModel` fields this group carries, by canonical
    /// snake_case name.
    pub const fn fields(self) -> &'static [&'static str] {
        match self {
            AdjustmentGroup::WhiteBalance => WHITE_BALANCE_FIELDS,
            AdjustmentGroup::Tone => TONE_FIELDS,
            AdjustmentGroup::Color => COLOR_FIELDS,
            AdjustmentGroup::Detail => DETAIL_FIELDS,
            AdjustmentGroup::Effects => EFFECTS_FIELDS,
            AdjustmentGroup::Geometry => GEOMETRY_FIELDS,
        }
    }
}

/// White balance. `temperature_seen` / `tint_seen` / `wb_scale_version` ride
/// along deliberately: they are not sliders, they are the interpretation
/// state for the two numbers above them (#1729, #1875). Copying
/// `temperature` without `wb_scale_version` would re-read the value on a
/// different slider scale and render the wrong white balance; copying it
/// without the `_seen` flags would silently convert an as-shot WB into an
/// explicit 6500 K / 0 authoring on the target.
const WHITE_BALANCE_FIELDS: &[&str] = &[
    "temperature",
    "tint",
    "temperature_seen",
    "tint_seen",
    "wb_method",
    "wb_scale_version",
];

/// Scene tone controls (spec § 3.6), the PV2012 parametric curve, and the
/// four point curves with their application mode. `auto_exposure` belongs
/// here because it is the anchor `exposure` stacks on top of — pasting one
/// without the other changes the resulting brightness.
const TONE_FIELDS: &[&str] = &[
    "exposure",
    "brightness",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "parametric_highlights",
    "parametric_lights",
    "parametric_darks",
    "parametric_shadows",
    "auto_exposure",
    "tone_curve_mode",
    "tone_curve_luma",
    "tone_curve_red",
    "tone_curve_green",
    "tone_curve_blue",
];

/// Saturation / vibrance, the 24 HSL band controls, split toning, and the
/// render-shaping enums (`profile`, `look`, `highlight_recovery`) that decide
/// how scene colour lands on the display.
const COLOR_FIELDS: &[&str] = &[
    "vibrance",
    "saturation",
    "hue_adjustment_red",
    "hue_adjustment_orange",
    "hue_adjustment_yellow",
    "hue_adjustment_green",
    "hue_adjustment_aqua",
    "hue_adjustment_blue",
    "hue_adjustment_purple",
    "hue_adjustment_magenta",
    "saturation_adjustment_red",
    "saturation_adjustment_orange",
    "saturation_adjustment_yellow",
    "saturation_adjustment_green",
    "saturation_adjustment_aqua",
    "saturation_adjustment_blue",
    "saturation_adjustment_purple",
    "saturation_adjustment_magenta",
    "luminance_adjustment_red",
    "luminance_adjustment_orange",
    "luminance_adjustment_yellow",
    "luminance_adjustment_green",
    "luminance_adjustment_aqua",
    "luminance_adjustment_blue",
    "luminance_adjustment_purple",
    "luminance_adjustment_magenta",
    // Black & white mix (#276) — the monochrome mode plus its 8 band
    // weights. Grouped with Colour rather than excluded: they drive the very
    // same Oklab 8-band kernel as the 24 HSL entries above, and a paste of
    // "Color" that dropped the conversion would land a colour render on an
    // image the user copied a monochrome look from. Nothing about them is
    // raster-derived, so they transfer between images unchanged.
    "black_white",
    "gray_mixer_red",
    "gray_mixer_orange",
    "gray_mixer_yellow",
    "gray_mixer_green",
    "gray_mixer_aqua",
    "gray_mixer_blue",
    "gray_mixer_purple",
    "gray_mixer_magenta",
    "split_tone_shadow_hue",
    "split_tone_shadow_saturation",
    "split_tone_highlight_hue",
    "split_tone_highlight_saturation",
    "split_tone_balance",
    "highlight_recovery",
    "look",
    "profile",
];

/// Sharpening, noise reduction, presence (clarity / texture), dehaze, and the
/// decode-product detail stages (#1104 / #1105 / #1106).
const DETAIL_FIELDS: &[&str] = &[
    "clarity",
    "texture",
    "dehaze",
    "sharpen_amount",
    "sharpen_radius",
    "sharpen_detail",
    "sharpen_masking",
    "capture_sharpening_amount",
    "capture_sharpening_sigma",
    "nr_luminance",
    "nr_color",
    "chroma_prefilter",
    "hot_pixel_suppression",
    "deep_denoise",
];

/// Vignette (#1109) and grain (#1110).
const EFFECTS_FIELDS: &[&str] = &[
    "vignette_amount",
    "vignette_feather",
    "grain_amount",
    "grain_size",
    "grain_roughness",
];

/// Crop rect + straighten angle. The rect is normalized to display-oriented
/// dimensions, so it maps proportionally onto a differently-sized target.
const GEOMETRY_FIELDS: &[&str] = &["crop"];

/// `AdjustmentModel` fields deliberately excluded from every group, i.e.
/// never moved by paste / sync. Every entry needs a reason; the coverage test
/// requires each struct field to be either grouped above or listed here.
pub const NON_COPYABLE_FIELDS: &[&str] = &[
    // Local-adjustment layers (#280). Copy-safe by construction (normalized
    // parametric masks) but absent from BOTH front-end `AdjustmentModel`
    // mirrors, so a "Masks" group would be a dead checkbox. See the module
    // doc for the full decision and the condition for promoting it.
    "local_adjustments",
    // Baked AI-removal layers (#1486). Raster-derived: each `Removal`
    // references a synthetic-raw patch content-hashed from THIS image's
    // pixels. Permanently excluded.
    "inpaint_removals",
    // Deprecated read-only alias for `capture_sharpening_sigma` (#456). No
    // code reads it after parse and no writer emits it, so copying it would
    // move a value that can never render.
    "capture_sharpening_radius",
];

#[cfg(test)]
mod tests;

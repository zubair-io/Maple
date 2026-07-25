//! Coverage tests for the copy/paste/sync group table. Split out of
//! `groups/mod.rs` to stay under the file-size budget, mirroring the
//! sibling `schema/mod.rs` + `schema/tests.rs` split.

#![cfg(test)]

use super::super::super::super::AdjustmentModel;
use super::*;
use std::collections::HashSet;

/// Every `AdjustmentModel` field, by canonical snake_case name.
///
/// Built by destructuring the struct so that adding a field without
/// touching this list is a **compile error**, exactly like the sibling
/// `schema_matches_struct` guard. That is what makes the coverage
/// assertions below trustworthy.
#[allow(deprecated)]
fn all_struct_field_names() -> Vec<&'static str> {
    let AdjustmentModel {
        temperature: _,
        tint: _,
        temperature_seen: _,
        tint_seen: _,
        wb_method: _,
        wb_scale_version: _,
        exposure: _,
        brightness: _,
        contrast: _,
        highlights: _,
        shadows: _,
        whites: _,
        blacks: _,
        parametric_highlights: _,
        parametric_lights: _,
        parametric_darks: _,
        parametric_shadows: _,
        vibrance: _,
        saturation: _,
        clarity: _,
        texture: _,
        sharpen_amount: _,
        sharpen_radius: _,
        sharpen_detail: _,
        sharpen_masking: _,
        capture_sharpening_amount: _,
        capture_sharpening_sigma: _,
        capture_sharpening_radius: _,
        nr_luminance: _,
        nr_color: _,
        dehaze: _,
        vignette_amount: _,
        vignette_feather: _,
        grain_amount: _,
        grain_size: _,
        grain_roughness: _,
        split_tone_shadow_hue: _,
        split_tone_shadow_saturation: _,
        split_tone_highlight_hue: _,
        split_tone_highlight_saturation: _,
        split_tone_balance: _,
        hue_adjustment_red: _,
        hue_adjustment_orange: _,
        hue_adjustment_yellow: _,
        hue_adjustment_green: _,
        hue_adjustment_aqua: _,
        hue_adjustment_blue: _,
        hue_adjustment_purple: _,
        hue_adjustment_magenta: _,
        saturation_adjustment_red: _,
        saturation_adjustment_orange: _,
        saturation_adjustment_yellow: _,
        saturation_adjustment_green: _,
        saturation_adjustment_aqua: _,
        saturation_adjustment_blue: _,
        saturation_adjustment_purple: _,
        saturation_adjustment_magenta: _,
        luminance_adjustment_red: _,
        luminance_adjustment_orange: _,
        luminance_adjustment_yellow: _,
        luminance_adjustment_green: _,
        luminance_adjustment_aqua: _,
        luminance_adjustment_blue: _,
        luminance_adjustment_purple: _,
        luminance_adjustment_magenta: _,
        highlight_recovery: _,
        auto_exposure: _,
        look: _,
        profile: _,
        local_adjustments: _,
        inpaint_removals: _,
        tone_curve_mode: _,
        tone_curve_luma: _,
        tone_curve_red: _,
        tone_curve_green: _,
        tone_curve_blue: _,
        chroma_prefilter: _,
        hot_pixel_suppression: _,
        deep_denoise: _,
        crop: _,
    } = AdjustmentModel::default();

    vec![
        "temperature",
        "tint",
        "temperature_seen",
        "tint_seen",
        "wb_method",
        "wb_scale_version",
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
        "vibrance",
        "saturation",
        "clarity",
        "texture",
        "sharpen_amount",
        "sharpen_radius",
        "sharpen_detail",
        "sharpen_masking",
        "capture_sharpening_amount",
        "capture_sharpening_sigma",
        "capture_sharpening_radius",
        "nr_luminance",
        "nr_color",
        "dehaze",
        "vignette_amount",
        "vignette_feather",
        "grain_amount",
        "grain_size",
        "grain_roughness",
        "split_tone_shadow_hue",
        "split_tone_shadow_saturation",
        "split_tone_highlight_hue",
        "split_tone_highlight_saturation",
        "split_tone_balance",
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
        "highlight_recovery",
        "auto_exposure",
        "look",
        "profile",
        "local_adjustments",
        "inpaint_removals",
        "tone_curve_mode",
        "tone_curve_luma",
        "tone_curve_red",
        "tone_curve_green",
        "tone_curve_blue",
        "chroma_prefilter",
        "hot_pixel_suppression",
        "deep_denoise",
        "crop",
    ]
}

/// The coverage contract: every field is grouped or explicitly excluded.
/// A newly-added slider that lands in neither list fails here rather than
/// being silently dropped by paste.
#[test]
fn every_field_is_grouped_or_explicitly_excluded() {
    let grouped: HashSet<&str> = AdjustmentGroup::ALL
        .iter()
        .flat_map(|g| g.fields().iter().copied())
        .collect();
    let excluded: HashSet<&str> = NON_COPYABLE_FIELDS.iter().copied().collect();

    let uncovered: Vec<&str> = all_struct_field_names()
        .into_iter()
        .filter(|name| !grouped.contains(name) && !excluded.contains(name))
        .collect();

    assert!(
        uncovered.is_empty(),
        "AdjustmentModel field(s) {:?} belong to no copy/paste group and \
         are not on NON_COPYABLE_FIELDS. Add them to a group in \
         schema/groups.rs (so paste carries them) or to \
         NON_COPYABLE_FIELDS with a reason.",
        uncovered
    );
}

/// No field may be claimed by two groups, and no field may be both
/// grouped and excluded — either would make paste order-dependent.
#[test]
fn groups_are_disjoint_and_do_not_overlap_exclusions() {
    let mut seen: HashSet<&str> = HashSet::new();
    for group in AdjustmentGroup::ALL {
        for name in group.fields() {
            assert!(
                seen.insert(name),
                "field `{}` appears in more than one adjustment group",
                name
            );
        }
    }
    for name in NON_COPYABLE_FIELDS {
        assert!(
            !seen.contains(name),
            "field `{}` is both grouped and listed as non-copyable",
            name
        );
    }
}

/// Group membership may only name real struct fields — a typo would
/// otherwise silently drop a slider from paste.
#[test]
fn group_fields_all_exist_on_the_struct() {
    let known: HashSet<&str> = all_struct_field_names().into_iter().collect();
    for group in AdjustmentGroup::ALL {
        for name in group.fields() {
            assert!(
                known.contains(name),
                "group `{}` names `{}`, which is not an AdjustmentModel field",
                group.id(),
                name
            );
        }
    }
    for name in NON_COPYABLE_FIELDS {
        assert!(
            known.contains(name),
            "NON_COPYABLE_FIELDS names `{}`, which is not an \
             AdjustmentModel field",
            name
        );
    }
}

/// Group ids and labels are unique and non-empty — they are storage keys
/// and UI strings on both platforms.
#[test]
fn group_ids_and_labels_are_unique() {
    let ids: HashSet<&str> = AdjustmentGroup::ALL.iter().map(|g| g.id()).collect();
    assert_eq!(ids.len(), AdjustmentGroup::ALL.len(), "duplicate group id");
    let labels: HashSet<&str> = AdjustmentGroup::ALL.iter().map(|g| g.label()).collect();
    assert_eq!(
        labels.len(),
        AdjustmentGroup::ALL.len(),
        "duplicate group label"
    );
    assert!(AdjustmentGroup::ALL
        .iter()
        .all(|g| !g.id().is_empty() && !g.label().is_empty()));
}

/// Local adjustments stay out of the copyable set until a front-end model
/// carries them. See the module doc for the full rationale — this test is
/// the tripwire that forces the decision to be re-made deliberately.
#[test]
fn mask_and_inpaint_fields_are_excluded() {
    assert!(NON_COPYABLE_FIELDS.contains(&"local_adjustments"));
    assert!(NON_COPYABLE_FIELDS.contains(&"inpaint_removals"));
}

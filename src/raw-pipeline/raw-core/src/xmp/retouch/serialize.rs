//! Fragment emitter for `crs:RetouchAreas` — the write side of `mod.rs`'s
//! walker, split out for the same size-budget reason as `parse.rs`.

use super::{AdjustmentModel, RetouchSpot, MASK_WHAT_CIRCULAR};

/// Six-decimal wire precision (`docs/xmp-canonical-format.md` § "Repair
/// spots"). Non-finite values cannot reach here — the model type's
/// `is_effective` gate drops them before the writer sees them.
fn fmt6(v: f32) -> String {
    format!("{v:.6}")
}

/// Emit the `crs:RetouchAreas` child element for `model.retouch_spots`, each
/// line prefixed so the container element sits at `indent` — the same
/// contract as `serialize_local_adjustments` and `serialize_tone_curves`.
/// Returns the empty string when there are no spots, so an unedited model
/// adds nothing to the document.
pub fn serialize_retouch_areas(model: &AdjustmentModel, indent: &str) -> String {
    if model.retouch_spots.is_empty() {
        return String::new();
    }
    let i1 = format!("{indent}  ");
    let i2 = format!("{indent}    ");
    let i3 = format!("{indent}      ");
    let i4 = format!("{indent}        ");
    let i5 = format!("{indent}          ");
    let i6 = format!("{indent}            ");

    let mut out = format!("{indent}<crs:RetouchAreas>\n{i1}<rdf:Seq>\n");
    for spot in &model.retouch_spots {
        out.push_str(&format!("{i2}<rdf:li>\n{i3}<rdf:Description\n"));
        out.push_str(&spot_attributes(spot, &i4));
        out.push_str(&format!(">\n{i4}<crs:Masks>\n{i5}<rdf:Seq>\n"));
        out.push_str(&mask_leaf(spot, &i6));
        out.push_str(&format!("{i5}</rdf:Seq>\n{i4}</crs:Masks>\n"));
        out.push_str(&format!("{i3}</rdf:Description>\n{i2}</rdf:li>\n"));
    }
    out.push_str(&format!("{i1}</rdf:Seq>\n{indent}</crs:RetouchAreas>"));
    out
}

/// The correction attributes. `crs:SourceState` and `crs:Method` are fixed:
/// Maple always stores the source the user placed (never a re-derived one)
/// and only models the circular brush, so writing Adobe's own values for
/// both keeps the document readable by Lightroom without claiming a
/// behaviour Maple does not have.
fn spot_attributes(spot: &RetouchSpot, indent: &str) -> String {
    format!(
        "{indent}crs:SpotType=\"{}\"\n\
         {indent}crs:SourceState=\"sourceSetExplicitly\"\n\
         {indent}crs:Method=\"circle\"\n\
         {indent}crs:SourceX=\"{}\"\n\
         {indent}crs:SourceY=\"{}\"\n\
         {indent}crs:Opacity=\"{}\"\n\
         {indent}crs:Feather=\"{}\"\n\
         {indent}crs:Seed=\"0\"",
        spot.kind.wire(),
        fmt6(spot.source.x),
        fmt6(spot.source.y),
        fmt6(spot.clamped_opacity()),
        fmt6(spot.clamped_feather()),
    )
}

fn mask_leaf(spot: &RetouchSpot, indent: &str) -> String {
    format!(
        "{indent}<rdf:li\n\
         {indent}  crs:What=\"{MASK_WHAT_CIRCULAR}\"\n\
         {indent}  crs:MaskValue=\"1\"\n\
         {indent}  crs:X=\"{}\"\n\
         {indent}  crs:Y=\"{}\"\n\
         {indent}  crs:Radius=\"{}\"\n\
         {indent}  crs:Flow=\"1\"\n\
         {indent}  crs:CenterWeight=\"0\"/>\n",
        fmt6(spot.center.x),
        fmt6(spot.center.y),
        fmt6(spot.radius),
    )
}

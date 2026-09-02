//! Fragment emitter for the canonical local-adjustments shape — the write
//! side of `mod.rs`'s walker, split into its own file for the same
//! size-budget reason as `parse.rs` (see that file's header).

use super::{AdjustmentModel, LocalAdjustment, Mask, PartialAdjustments};
use super::{LINEAR_CONTAINER, MASK_WHAT_LINEAR, MASK_WHAT_RADIAL, RADIAL_CONTAINER};

/// Round to the canonical 2-decimal wire precision
/// (`docs/xmp-canonical-format.md` § "Number formatting"). Values here are
/// UI-set floats, not pixel math, but the round mirrors the parametric
/// tone-curve block's belt-and-braces guard against float noise.
fn fmt2(v: f32) -> String {
    let rounded = (v * 100.0).round() / 100.0;
    format!("{rounded}")
}

/// Emit the canonical `crs:GradientBasedCorrections` /
/// `crs:CircularGradientBasedCorrections` nested child elements for
/// `model.local_adjustments`, each line prefixed so the container element
/// sits at `indent` — same contract as [`super::super::serialize_tone_curves`].
/// Returns the empty string when there are no layers, so an unedited model
/// adds nothing to the document.
pub fn serialize_local_adjustments(model: &AdjustmentModel, indent: &str) -> String {
    let linear: Vec<&LocalAdjustment> = model
        .local_adjustments
        .iter()
        .filter(|l| matches!(l.mask, Mask::Linear { .. }))
        .collect();
    let radial: Vec<&LocalAdjustment> = model
        .local_adjustments
        .iter()
        .filter(|l| matches!(l.mask, Mask::Radial { .. }))
        .collect();

    let mut out = String::new();
    if !linear.is_empty() {
        out.push_str(&serialize_container(LINEAR_CONTAINER, &linear, indent));
    }
    if !radial.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&serialize_container(RADIAL_CONTAINER, &radial, indent));
    }
    out
}

fn serialize_container(container: &str, layers: &[&LocalAdjustment], indent: &str) -> String {
    let i1 = format!("{indent}  ");
    let i2 = format!("{indent}    ");
    let i3 = format!("{indent}      ");
    let i4 = format!("{indent}        ");
    let i5 = format!("{indent}          ");

    let mut out = format!("{indent}<{container}>\n{i1}<rdf:Seq>\n");
    for layer in layers {
        out.push_str(&format!("{i2}<rdf:li>\n"));
        out.push_str(&format!("{i3}<rdf:Description\n"));
        out.push_str(&format!(
            "{i4}crs:What=\"Correction\"\n{i4}crs:CorrectionAmount=\"1\"\n{i4}crs:CorrectionActive=\"True\""
        ));
        out.push_str(&serialize_adjustments(&layer.adjustments, &i4));
        out.push_str(&format!(">\n{i4}<crs:CorrectionMasks>\n{i3}  <rdf:Seq>\n"));
        out.push_str(&serialize_mask(&layer.mask, &i5));
        out.push_str(&format!("{i3}  </rdf:Seq>\n{i4}</crs:CorrectionMasks>\n"));
        out.push_str(&format!("{i3}</rdf:Description>\n{i2}</rdf:li>\n"));
    }
    out.push_str(&format!("{i1}</rdf:Seq>\n{indent}</{container}>"));
    out
}

fn serialize_adjustments(a: &PartialAdjustments, indent: &str) -> String {
    let mut out = String::new();
    for (key, value) in [
        ("crs:LocalExposure2012", a.exposure),
        ("crs:LocalContrast2012", a.contrast),
        ("crs:LocalHighlights2012", a.highlights),
        ("crs:LocalShadows2012", a.shadows),
        ("crs:LocalWhites2012", a.whites),
        ("crs:LocalBlacks2012", a.blacks),
        ("crs:LocalSaturation", a.saturation),
        ("papp:LocalVibrance", a.vibrance),
        ("crs:LocalTemperature", a.temperature),
        ("crs:LocalTint", a.tint),
    ] {
        if let Some(v) = value {
            out.push_str(&format!("\n{indent}{key}=\"{}\"", fmt2(v)));
        }
    }
    out
}

fn serialize_mask(mask: &Mask, indent: &str) -> String {
    match *mask {
        Mask::Linear {
            start,
            end,
            feather,
        } => format!(
            "{indent}<rdf:li\n\
             {indent}  crs:What=\"{MASK_WHAT_LINEAR}\"\n\
             {indent}  crs:MaskValue=\"1\"\n\
             {indent}  crs:ZeroX=\"{}\" crs:ZeroY=\"{}\"\n\
             {indent}  crs:FullX=\"{}\" crs:FullY=\"{}\"\n\
             {indent}  papp:LocalFeather=\"{}\"/>\n",
            fmt2(start.x),
            fmt2(start.y),
            fmt2(end.x),
            fmt2(end.y),
            fmt2(feather),
        ),
        Mask::Radial {
            center,
            radii,
            angle,
            feather,
            invert,
        } => {
            let top = center.y - radii.y;
            let left = center.x - radii.x;
            let bottom = center.y + radii.y;
            let right = center.x + radii.x;
            format!(
                "{indent}<rdf:li\n\
                 {indent}  crs:What=\"{MASK_WHAT_RADIAL}\"\n\
                 {indent}  crs:MaskValue=\"1\"\n\
                 {indent}  crs:Top=\"{}\" crs:Left=\"{}\" crs:Bottom=\"{}\" crs:Right=\"{}\"\n\
                 {indent}  crs:Angle=\"{}\" crs:Midpoint=\"50\" crs:Roundness=\"0\"\n\
                 {indent}  crs:Feather=\"{}\" crs:Flipped=\"{}\"/>\n",
                fmt2(top),
                fmt2(left),
                fmt2(bottom),
                fmt2(right),
                fmt2(angle.to_degrees()),
                fmt2(feather * 100.0),
                if invert { "True" } else { "False" },
            )
        }
    }
}

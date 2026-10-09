//! Fragment emitter for the canonical local-adjustments shape — the write
//! side of `mod.rs`'s walker, split into its own file for the same
//! size-budget reason as `parse.rs` (see that file's header).

use super::{AdjustmentModel, LocalAdjustment, Mask, PartialAdjustments, RangeRefinement};
use super::{
    BRUSH_CONTAINER, GROUP_CONTAINER, LINEAR_CONTAINER, MASK_WHAT_IMAGE, MASK_WHAT_LINEAR,
    MASK_WHAT_PAINT, MASK_WHAT_RADIAL, RADIAL_CONTAINER,
};
use crate::types::local_adjustment::flat::MASK_GROUP_VERSION;
use crate::types::local_adjustment::{BrushDab, BRUSH_VERSION};
use crate::types::{MaskCombine, MaskSource};

/// Round to the canonical 2-decimal wire precision
/// (`docs/xmp-canonical-format.md` § "Number formatting"). Values here are
/// UI-set floats, not pixel math, but the round mirrors the parametric
/// tone-curve block's belt-and-braces guard against float noise.
fn fmt2(v: f32) -> String {
    let rounded = (v * 100.0).round() / 100.0;
    format!("{rounded}")
}

/// `crs:LocalHue` rides Adobe's ±1 scale, so the canonical 2-decimal wire
/// precision would quantise Maple's ±100 slider to whole units and drift a
/// fractional value (e.g. an Amount-scaled −42.5) on every round-trip
/// (#3280 review). Four decimals keep two decimals of the ±100 value.
fn fmt4(v: f32) -> String {
    let rounded = (v * 10_000.0).round() / 10_000.0;
    format!("{rounded}")
}

fn fmt_mask_coord(v: f32) -> String {
    let rounded = (f64::from(v) * 1_000_000.0).round() / 1_000_000.0;
    if rounded == 0.0 {
        return "0".into();
    }
    format!("{rounded:.6}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .into()
}

/// Emit the canonical `crs:GradientBasedCorrections` /
/// `crs:CircularGradientBasedCorrections` / `papp:BrushCorrections` /
/// `crs:MaskGroupBasedCorrections` nested child elements for
/// `model.local_adjustments`, each line prefixed so the container element
/// sits at `indent` — same contract as [`super::super::serialize_tone_curves`].
/// Returns the empty string when there are no layers, so an unedited model
/// adds nothing to the document.
pub fn serialize_local_adjustments(model: &AdjustmentModel, indent: &str) -> String {
    let linear: Vec<&LocalAdjustment> = model
        .local_adjustments
        .iter()
        .filter(|l| matches!(&l.mask, Mask::Linear { .. }))
        .collect();
    let radial: Vec<&LocalAdjustment> = model
        .local_adjustments
        .iter()
        .filter(|l| matches!(&l.mask, Mask::Radial { .. }))
        .collect();
    // Brush (#360) rides Maple's own container, never Adobe's paint one.
    let paint: Vec<&LocalAdjustment> = model
        .local_adjustments
        .iter()
        .filter(|l| matches!(&l.mask, Mask::Brush { .. }))
        .collect();
    // Bitmap and Everywhere (#3271) share a fourth container — Lightroom
    // 11+'s own shape for its AI masks, `crs:MaskGroupBasedCorrections`.
    let group: Vec<&LocalAdjustment> = model
        .local_adjustments
        .iter()
        .filter(|l| {
            matches!(
                &l.mask,
                Mask::Bitmap { .. } | Mask::Everywhere | Mask::Group(_)
            )
        })
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
    if !paint.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&serialize_container(BRUSH_CONTAINER, &paint, indent));
    }
    if !group.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&serialize_container(GROUP_CONTAINER, &group, indent));
    }
    out
}

fn serialize_container(container: &str, layers: &[&LocalAdjustment], indent: &str) -> String {
    let i1 = format!("{indent}  ");
    let i2 = format!("{indent}    ");
    let i3 = format!("{indent}      ");
    let i4 = format!("{indent}        ");
    let i5 = format!("{indent}          ");
    let i6 = format!("{indent}            ");

    let mut out = format!("{indent}<{container}>\n{i1}<rdf:Seq>\n");
    for layer in layers {
        out.push_str(&format!("{i2}<rdf:li>\n"));
        out.push_str(&format!("{i3}<rdf:Description\n"));
        out.push_str(&format!(
            "{i4}crs:What=\"Correction\"\n{i4}crs:CorrectionAmount=\"1\"\n{i4}crs:CorrectionActive=\"True\""
        ));
        out.push_str(&serialize_adjustments(&layer.adjustments, &i4));
        out.push_str(&serialize_range(layer.range, &i4));
        if let Mask::Group(group) = &layer.mask {
            out.push_str(&format!("\n{i4}papp:MaskGroupVersion=\"{MASK_GROUP_VERSION}\"\n{i4}papp:MaskGroupOpacity=\"{}\"\n{i4}papp:MaskGroupInverted=\"{}\"",
                group.opacity, if group.invert { "True" } else { "False" }));
        }
        // One ladder, two spaces per level (`docs/xmp-canonical-format.md`
        // § "Indentation"): `crs:CorrectionMasks` sits with the correction's
        // attributes, its `rdf:Seq` one step in, the mask leaf one further.
        out.push_str(&format!(">\n{i4}<crs:CorrectionMasks>\n{i5}<rdf:Seq>\n"));
        out.push_str(&serialize_mask(&layer.mask, &i6));
        out.push_str(&format!("{i5}</rdf:Seq>\n{i4}</crs:CorrectionMasks>\n"));
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
    // Hue (#3269) and the six spatial controls (#3407): Maple's sliders are
    // ±100 (0…100 for noise and defringe), Adobe's keys are the ±1 fraction
    // Lightroom writes, so these can't ride the plain loop above. Four
    // decimals keep two decimals of the ±100 value through the round trip.
    for (key, value) in [
        ("crs:LocalHue", a.hue),
        ("crs:LocalTexture", a.texture),
        ("crs:LocalClarity2012", a.clarity),
        ("crs:LocalDehaze", a.dehaze),
        ("crs:LocalSharpness", a.sharpness),
        ("crs:LocalLuminanceNoise", a.luminance_noise),
        ("crs:LocalDefringe", a.defringe),
    ] {
        if let Some(v) = value {
            out.push_str(&format!("\n{indent}{key}=\"{}\"", fmt4(v / 100.0)));
        }
    }
    out
}

/// The colour-range refinement's `papp:Range*` attributes (#3270, spec
/// §5.2), on the SAME `rdf:Description` the sliders live on — Maple-private
/// by design (Adobe has no range-mask schema to borrow), so a reference
/// renderer that ignores them still applies the correction through the
/// primary mask.
fn serialize_range(range: Option<RangeRefinement>, indent: &str) -> String {
    let Some(RangeRefinement::Color {
        hue_deg,
        hue_half_width_deg,
        chroma_min,
        l_min,
        l_max,
        feather,
    }) = range
    else {
        return String::new();
    };
    format!(
        "\n{indent}papp:RangeKind=\"Color\"\n\
         {indent}papp:RangeHue=\"{}\"\n\
         {indent}papp:RangeHueWidth=\"{}\"\n\
         {indent}papp:RangeChromaMin=\"{}\"\n\
         {indent}papp:RangeLMin=\"{}\"\n\
         {indent}papp:RangeLMax=\"{}\"\n\
         {indent}papp:RangeFeather=\"{}\"",
        fmt2(hue_deg),
        fmt2(hue_half_width_deg),
        fmt2(chroma_min),
        fmt2(l_min),
        fmt2(l_max),
        fmt2(feather),
    )
}

fn serialize_mask(mask: &Mask, indent: &str) -> String {
    match mask {
        Mask::Bitmap { recipe, .. } => match recipe.source {
            MaskSource::PersonSkin => format!(
                "{indent}<rdf:li\n\
                 {indent}  crs:What=\"{MASK_WHAT_IMAGE}\"\n\
                 {indent}  crs:MaskSubType=\"1\"\n\
                 {indent}  crs:MaskValue=\"1\"\n\
                 {indent}  papp:MaskSource=\"{}\"\n\
                 {indent}  papp:MaskPerson=\"{}\"\n\
                 {indent}  papp:MaskFacialSkin=\"{}\"\n\
                 {indent}  papp:MaskBodySkin=\"{}\"\n\
                 {indent}  papp:MaskModel=\"{}\"\n\
                 {indent}  papp:MaskDigest=\"{}\"/>\n",
                recipe.source.xmp_name(),
                recipe.person,
                if recipe.facial_skin { "True" } else { "False" },
                if recipe.body_skin { "True" } else { "False" },
                escape_attr(&recipe.model),
                escape_attr(&recipe.digest),
            ),
            // A sky selection (#361) carries no person/skin attributes —
            // model + digest regenerate the raster on any host.
            MaskSource::Sky => format!(
                "{indent}<rdf:li\n\
                 {indent}  crs:What=\"{MASK_WHAT_IMAGE}\"\n\
                 {indent}  crs:MaskSubType=\"1\"\n\
                 {indent}  crs:MaskValue=\"1\"\n\
                 {indent}  papp:MaskSource=\"{}\"\n\
                 {indent}  papp:MaskModel=\"{}\"\n\
                 {indent}  papp:MaskDigest=\"{}\"/>\n",
                recipe.source.xmp_name(),
                escape_attr(&recipe.model),
                escape_attr(&recipe.digest),
            ),
        },
        Mask::Everywhere => format!(
            "{indent}<rdf:li\n\
             {indent}  crs:What=\"{MASK_WHAT_IMAGE}\"\n\
             {indent}  crs:MaskValue=\"1\"\n\
             {indent}  papp:MaskSource=\"Everywhere\"/>\n"
        ),
        Mask::Brush {
            dabs, digest, ..
        } => {
            // `raster_id` is never written: it is an in-process registry
            // handle, re-resolved from the dabs or `papp:BrushDigest` on load.
            let dabs_attr = write_dab_series(dabs);
            let dabs_line = if dabs_attr.is_empty() {
                String::new()
            } else {
                format!("\n{indent}  papp:Dabs=\"{dabs_attr}\"")
            };
            let digest_line = if digest.is_empty() {
                String::new()
            } else {
                format!("\n{indent}  papp:BrushDigest=\"{}\"", escape_attr(digest))
            };
            format!(
                "{indent}<rdf:li\n\
                 {indent}  crs:What=\"{MASK_WHAT_PAINT}\"\n\
                 {indent}  crs:MaskValue=\"1\"\n\
                 {indent}  papp:BrushVersion=\"{BRUSH_VERSION}\"{dabs_line}{digest_line}/>\n"
            )
        }
        Mask::Group(group) => group.components.iter().map(|component| {
            let xml = match component.mask() {
                Mask::Linear { .. } | Mask::Radial { .. } => serialize_geometric_mask(component.mask(), indent, true),
                _ => serialize_mask(component.mask(), indent),
            };
            let subtract = component.combine != MaskCombine::Add;
            let inverted = component.invert ^ (component.combine == MaskCombine::Intersect);
            xml.replacen("crs:MaskValue=\"1\"", &format!("crs:MaskValue=\"{}\"", if subtract { 0 } else { 1 }), 1)
                .replacen("/>\n", &format!("\n{indent}  papp:MaskCombine=\"{}\"/>\n", component.combine.name()), 1)
                .replacen("/>\n", &format!("\n{indent}  crs:MaskActive=\"True\"\n{indent}  crs:MaskBlendMode=\"{}\"\n{indent}  crs:MaskInverted=\"{}\"/>\n",
                    if subtract { 1 } else { 0 }, if inverted { "True" } else { "False" }), 1)
        }).collect(),
        _ => serialize_geometric_mask(mask, indent, false),
    }
}

/// Encode a dab series as the `papp:Dabs` attribute value: six
/// whitespace-separated tokens per dab — `x y radius feather weight erase`.
/// Positions and radius ride the 6-decimal mask-coordinate format;
/// feather/weight ride 4 decimals (the rasterizer quantizes to R8, so deeper
/// precision would be unwritten precision); erase is `0`/`1`.
/// `docs/xmp-canonical-format.md` § "Brush masks (paint)" is the contract.
///
/// Dabs with a non-finite field are dropped, not written: one bad stamp in
/// hundreds is a host bug, not a misplaced mask, and emitting it would
/// produce a sidecar this module's own reader rejects.
fn write_dab_series(dabs: &[BrushDab]) -> String {
    dabs.iter()
        .filter(|d| {
            d.center.x.is_finite()
                && d.center.y.is_finite()
                && d.radius.is_finite()
                && d.feather.is_finite()
                && d.weight.is_finite()
        })
        .map(|d| {
            format!(
                "{} {} {} {} {} {}",
                fmt_mask_coord(d.center.x),
                fmt_mask_coord(d.center.y),
                fmt_mask_coord(d.radius),
                fmt4(d.feather),
                fmt4(d.weight),
                if d.erase { 1 } else { 0 },
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Minimal XML-attribute escaping for the free-text recipe fields
/// (`MaskModel`, `MaskDigest`, `BrushDigest`) — every other value on this
/// element is a closed enum or a formatted number, so this is the one place
/// a `crs:*`/`papp:*` attribute value could legally contain `&`/`<`/`"`.
fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;")
}

/// Only ever called for `Linear`/`Radial` — [`serialize_mask`] routes
/// `Bitmap`/`Everywhere`/`Brush` to their own arms before falling through here.
fn serialize_geometric_mask(mask: &Mask, indent: &str, modern: bool) -> String {
    let number = |value: f32| {
        if modern {
            value.to_string()
        } else {
            fmt2(value)
        }
    };
    let coordinate = |value: f32| {
        if modern {
            value.to_string()
        } else {
            fmt_mask_coord(value)
        }
    };
    match *mask {
        Mask::Bitmap { .. } | Mask::Brush { .. } | Mask::Everywhere | Mask::Group(_) => {
            unreachable!("serialize_mask routes Bitmap/Brush/Everywhere before calling this")
        }
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
            coordinate(start.x),
            coordinate(start.y),
            coordinate(end.x),
            coordinate(end.y),
            number(feather),
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
                 {indent}  crs:Feather=\"{}\" crs:Flipped=\"{}\"{}/>\n",
                coordinate(top),
                coordinate(left),
                coordinate(bottom),
                coordinate(right),
                number(angle.to_degrees()),
                number(feather * if modern { 50.0 } else { 100.0 }),
                if invert ^ modern { "True" } else { "False" },
                if modern { " crs:Version=\"2\"" } else { "" },
            )
        }
    }
}

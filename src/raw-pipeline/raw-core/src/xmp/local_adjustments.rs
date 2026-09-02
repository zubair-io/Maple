//! Nested-element XMP I/O for local adjustments (#358), canonical form.
//!
//! Slice 1 of #280 shipped `papp:LocalAdjustments`: a single XMP attribute
//! holding compact JSON (see [`crate::types::local_adjustment::wire`]). That
//! format is parser-cheap but opaque to every reference renderer — ACR and
//! Lightroom have no idea what a `papp:` JSON blob means, so a Maple-authored
//! local adjustment silently vanished on export/import round trips through
//! those tools. This module replaces it with the canonical Adobe Camera Raw
//! shape: `crs:GradientBasedCorrections` (linear masks) and
//! `crs:CircularGradientBasedCorrections` (radial masks), each an `rdf:Seq`
//! of `rdf:li` → `rdf:Description` "corrections", each carrying the
//! `crs:Local*2012` sliders and one `crs:CorrectionMasks` mask descriptor:
//!
//! ```xml
//! <crs:GradientBasedCorrections>
//!   <rdf:Seq>
//!     <rdf:li>
//!       <rdf:Description
//!         crs:What="Correction"
//!         crs:CorrectionAmount="1"
//!         crs:CorrectionActive="True"
//!         crs:LocalExposure2012="0.5"
//!         crs:LocalContrast2012="10">
//!         <crs:CorrectionMasks>
//!           <rdf:Seq>
//!             <rdf:li
//!               crs:What="Mask/Gradient"
//!               crs:MaskValue="1"
//!               crs:ZeroX="0.2" crs:ZeroY="0.3"
//!               crs:FullX="0.8" crs:FullY="0.7"
//!               papp:LocalFeather="0.5"/>
//!           </rdf:Seq>
//!         </crs:CorrectionMasks>
//!       </rdf:Description>
//!     </rdf:li>
//!   </rdf:Seq>
//! </crs:GradientBasedCorrections>
//! ```
//!
//! **Migration.** The old `papp:LocalAdjustments` attribute is still *read*
//! (`xmp::fields::set_field`, tolerant JSON decode in
//! [`crate::types::local_adjustment::wire`]) — a hand-authored fixture from
//! before this ticket still loads — but is never written again. When a
//! document carries both (should not happen outside a hand-edited fixture),
//! the canonical nested form wins: [`super::parse`] applies the legacy
//! attribute first (document order, wherever it appears) and then
//! overwrites `model.local_adjustments` with whatever this walker collected,
//! iff it collected at least one layer. `docs/xmp-canonical-format.md` §
//! "Local adjustments" states this precedence rule.
//!
//! **Field mapping.** Adobe's local-correction struct has no `Vibrance`
//! control (only `LocalSaturation`), so `vibrance` rides Maple's own
//! `papp:LocalVibrance` — same "papp: for what Adobe has no equivalent for"
//! rule the top-level schema follows. Every other `PartialAdjustments` field
//! has a direct Adobe key (`crs:Local{Exposure,Contrast,Highlights,Shadows,
//! Whites,Blacks}2012`, `crs:LocalSaturation`, `crs:Local{Temperature,Tint}`).
//!
//! **Mask geometry.** Maple's [`Mask::Linear`] maps directly onto Adobe's
//! `ZeroX/ZeroY` (0%-effect line) → `FullX/FullY` (100%-effect line) pair —
//! but Adobe's linear mask carries no separate feather magnitude; the
//! Zero→Full distance *is* its transition. Maple's `feather` (a fraction of
//! gradient length, independent of the endpoints) has no Adobe home, so it
//! rides `papp:LocalFeather`; a foreign (ACR-authored) gradient without that
//! attribute defaults to `0.5`, matching [`LocalAdjustment::linear`]'s own
//! default. [`Mask::Radial`] maps onto Adobe's bounding-box form
//! (`Top/Left/Bottom/Right` = `center ± radii`, `Angle` in degrees,
//! `Feather` 0–100, `Flipped` = `invert`); Adobe's `Roundness` (ellipse vs.
//! rounded-rect blend) and `Midpoint` (where the 100%→0% falloff begins)
//! have no Maple equivalent, so the writer fixes them at Adobe's own
//! "pure ellipse, full-strength core" defaults (`Roundness="0"`,
//! `Midpoint="50"`) and the reader ignores both on import — a foreign
//! radial mask with non-zero `Roundness` imports as the nearest ellipse
//! rather than failing, since the ticket's bar is "reasonable results
//! in a third-party renderer", not exact re-derivation of Maple's UI state
//! from arbitrary foreign masks.
//!
//! **Cross-type order.** Adobe's schema keeps linear and radial corrections
//! in two separate top-level arrays, so a document with layers interleaved
//! in the model (linear, radial, linear, …) round-trips through the wire
//! form as two contiguous runs (all linear, then all radial) rather than
//! preserving cross-type interleaving. No UI writes this format yet, so nothing
//! observes that reordering today; it is called out here so it isn't
//! rediscovered as a bug later.
//!
//! **Tolerant reader**, matching [`crate::types::local_adjustment::wire`]'s
//! stated contract for this feature: a `crs:CorrectionMasks` entry whose
//! `crs:What` is not `Mask/Gradient` or `Mask/CircularGradient` (a brush,
//! range, or AI mask — none of which Maple models) is skipped, which drops
//! that one correction (no mask ⇒ nothing to render) without failing the
//! whole subtree or the parse. A *recognized* mask or correction with a
//! non-numeric value on a known attribute is a hard parse error, matching
//! every other numeric key in the schema (`docs/xmp-canonical-format.md` §
//! "Enum fields and parse strictness").

use super::AdjustmentModel;
use crate::error::{Error, Result};
use crate::types::local_adjustment::{LocalAdjustment, Mask, PartialAdjustments, Point2};
use quick_xml::events::BytesStart;

const LINEAR_CONTAINER: &str = "crs:GradientBasedCorrections";
const RADIAL_CONTAINER: &str = "crs:CircularGradientBasedCorrections";
const MASKS: &str = "crs:CorrectionMasks";
const MASK_WHAT_LINEAR: &str = "Mask/Gradient";
const MASK_WHAT_RADIAL: &str = "Mask/CircularGradient";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Linear,
    Radial,
}

fn is_seq(name: &str) -> bool {
    name == "Seq" || name.ends_with(":Seq")
}
fn is_li(name: &str) -> bool {
    name == "li" || name.ends_with(":li")
}
fn is_description(name: &str) -> bool {
    name == "Description" || name.ends_with(":Description")
}

/// Round to the canonical 2-decimal wire precision
/// (`docs/xmp-canonical-format.md` § "Number formatting"). Values here are
/// UI-set floats, not pixel math, but the round mirrors the parametric
/// tone-curve block's belt-and-braces guard against float noise.
fn fmt2(v: f32) -> String {
    let rounded = (v * 100.0).round() / 100.0;
    format!("{rounded}")
}

fn attr_str(e: &BytesStart<'_>, key: &str) -> Result<Option<String>> {
    for attr_result in e.attributes() {
        let attr = attr_result.map_err(|err| Error::Xmp(err.to_string()))?;
        let k =
            std::str::from_utf8(attr.key.as_ref()).map_err(|err| Error::Xmp(err.to_string()))?;
        if k == key {
            let v = attr
                .unescape_value()
                .map_err(|err| Error::Xmp(err.to_string()))?;
            return Ok(Some(v.into_owned()));
        }
    }
    Ok(None)
}

fn attr_f32(e: &BytesStart<'_>, key: &str) -> Result<Option<f32>> {
    match attr_str(e, key)? {
        Some(v) => {
            let parsed: f32 = v
                .parse()
                .map_err(|err| Error::Xmp(format!("{key} has non-numeric value {v}: {err}")))?;
            if !parsed.is_finite() {
                return Err(Error::Xmp(format!("{key} has non-finite value {v}")));
            }
            Ok(Some(parsed))
        }
        None => Ok(None),
    }
}

/// Parse a correction `rdf:Description`'s Local* sliders. Unrecognized
/// attributes (the bookkeeping `crs:What`/`CorrectionAmount`/
/// `CorrectionActive`, or anything foreign) are ignored — this is a fixed
/// field list, not the general passthrough mechanism the three shells own.
fn parse_correction_attrs(e: &BytesStart<'_>) -> Result<PartialAdjustments> {
    Ok(PartialAdjustments {
        exposure: attr_f32(e, "crs:LocalExposure2012")?,
        contrast: attr_f32(e, "crs:LocalContrast2012")?,
        highlights: attr_f32(e, "crs:LocalHighlights2012")?,
        shadows: attr_f32(e, "crs:LocalShadows2012")?,
        whites: attr_f32(e, "crs:LocalWhites2012")?,
        blacks: attr_f32(e, "crs:LocalBlacks2012")?,
        saturation: attr_f32(e, "crs:LocalSaturation")?,
        vibrance: attr_f32(e, "papp:LocalVibrance")?,
        temperature: attr_f32(e, "crs:LocalTemperature")?,
        tint: attr_f32(e, "crs:LocalTint")?,
    })
}

/// Parse one `crs:CorrectionMasks > rdf:Seq > rdf:li` mask descriptor.
/// `Ok(None)` = an unrecognized `crs:What` (skip, forward-compat with mask
/// kinds Maple doesn't model); `Err` = a recognized shape with a corrupt
/// numeric field.
fn parse_mask_attrs(kind: Kind, e: &BytesStart<'_>) -> Result<Option<Mask>> {
    let what = attr_str(e, "crs:What")?;
    let recognized = matches!(
        (kind, what.as_deref()),
        (Kind::Linear, Some(MASK_WHAT_LINEAR)) | (Kind::Radial, Some(MASK_WHAT_RADIAL))
    );
    if !recognized {
        return Ok(None);
    }
    match kind {
        Kind::Linear => {
            let zero_x = attr_f32(e, "crs:ZeroX")?.unwrap_or(0.0);
            let zero_y = attr_f32(e, "crs:ZeroY")?.unwrap_or(0.0);
            let full_x = attr_f32(e, "crs:FullX")?.unwrap_or(1.0);
            let full_y = attr_f32(e, "crs:FullY")?.unwrap_or(1.0);
            let feather = attr_f32(e, "papp:LocalFeather")?.unwrap_or(0.5);
            Ok(Some(Mask::Linear {
                start: Point2::new(zero_x, zero_y),
                end: Point2::new(full_x, full_y),
                feather,
            }))
        }
        Kind::Radial => {
            let top = attr_f32(e, "crs:Top")?.unwrap_or(0.0);
            let left = attr_f32(e, "crs:Left")?.unwrap_or(0.0);
            let bottom = attr_f32(e, "crs:Bottom")?.unwrap_or(1.0);
            let right = attr_f32(e, "crs:Right")?.unwrap_or(1.0);
            let angle_deg = attr_f32(e, "crs:Angle")?.unwrap_or(0.0);
            let feather_pct = attr_f32(e, "crs:Feather")?.unwrap_or(50.0);
            let flipped = attr_str(e, "crs:Flipped")?
                .map(|v| matches!(v.as_ref(), "true" | "True"))
                .unwrap_or(false);
            Ok(Some(Mask::Radial {
                center: Point2::new((left + right) / 2.0, (top + bottom) / 2.0),
                radii: Point2::new((right - left) / 2.0, (bottom - top) / 2.0),
                angle: angle_deg.to_radians(),
                feather: (feather_pct / 100.0).clamp(0.0, 1.0),
                invert: flipped,
            }))
        }
    }
}

/// Incremental state for the local-adjustments nested-element walk, driven
/// by [`super::parse`] exactly like [`super::tone_curves::CurveWalker`].
/// Explicit fields rather than a generic stack: the schema this walks is a
/// single fixed shape six levels deep, not an arbitrary tree.
#[derive(Default)]
pub(super) struct LocalAdjustmentsWalker {
    container: Option<Kind>,
    in_container_seq: bool,
    in_layer_li: bool,
    /// `Some` once inside a correction's `rdf:Description`.
    current: Option<(PartialAdjustments, Option<Mask>)>,
    in_masks: bool,
    in_masks_seq: bool,
    finished: Vec<LocalAdjustment>,
}

impl LocalAdjustmentsWalker {
    /// Handle an element opening (`Event::Start`). Returns `true` when the
    /// element is part of (or opens) a local-adjustments subtree, in which
    /// case the caller skips the flat crs:/papp: attribute walk for it.
    pub(super) fn start(&mut self, name: &str, e: &BytesStart<'_>) -> Result<bool> {
        if self.container.is_none() {
            self.container = match name {
                LINEAR_CONTAINER => Some(Kind::Linear),
                RADIAL_CONTAINER => Some(Kind::Radial),
                _ => None,
            };
            return Ok(self.container.is_some());
        }
        if self.current.is_none() {
            if !self.in_container_seq && is_seq(name) {
                self.in_container_seq = true;
                return Ok(true);
            }
            if self.in_container_seq && !self.in_layer_li && is_li(name) {
                self.in_layer_li = true;
                return Ok(true);
            }
            if self.in_layer_li && is_description(name) {
                self.current = Some((parse_correction_attrs(e)?, None));
                return Ok(true);
            }
            // Stray content inside the container we don't otherwise
            // recognize — swallow it rather than let it hit the flat
            // attribute walk, but don't model it.
            return Ok(true);
        }
        if !self.in_masks && name == MASKS {
            self.in_masks = true;
            return Ok(true);
        }
        if self.in_masks && !self.in_masks_seq && is_seq(name) {
            self.in_masks_seq = true;
            return Ok(true);
        }
        Ok(true)
    }

    /// Handle a self-closing element (`Event::Empty`) — the mask `rdf:li`
    /// leaves are always written this way (no children, attributes only).
    /// Returns `true` when handled.
    pub(super) fn empty(&mut self, name: &str, e: &BytesStart<'_>) -> Result<bool> {
        if self.container.is_none() {
            return Ok(false);
        }
        if self.in_masks_seq && is_li(name) {
            if let Some((_, mask_slot)) = self.current.as_mut() {
                if mask_slot.is_none() {
                    let kind = self.container.expect("container set while in_masks_seq");
                    *mask_slot = parse_mask_attrs(kind, e)?;
                }
            }
            return Ok(true);
        }
        Ok(true)
    }

    /// Handle an element closing (`Event::End`).
    pub(super) fn end(&mut self, name: &str) {
        if self.container.is_none() {
            return;
        }
        if self.in_masks_seq {
            if is_seq(name) {
                self.in_masks_seq = false;
            }
            return;
        }
        if self.in_masks {
            if name == MASKS {
                self.in_masks = false;
            }
            return;
        }
        if let Some((adjustments, mask)) = self.current.take() {
            if is_description(name) {
                // Recognized mask ⇒ commit; no mask (unrecognized `What`, or
                // none at all) ⇒ drop this one correction, forward-compat.
                if let Some(mask) = mask {
                    self.finished.push(LocalAdjustment { mask, adjustments });
                }
            } else {
                // Not the Description closing yet — put the in-progress
                // correction back and keep waiting.
                self.current = Some((adjustments, mask));
            }
            return;
        }
        if self.in_layer_li {
            if is_li(name) {
                self.in_layer_li = false;
            }
            return;
        }
        if self.in_container_seq {
            if is_seq(name) {
                self.in_container_seq = false;
            }
            return;
        }
        if name == LINEAR_CONTAINER || name == RADIAL_CONTAINER {
            self.container = None;
        }
    }

    /// Consume the walker, returning every layer collected across both
    /// containers in document order (all `GradientBasedCorrections` layers,
    /// then all `CircularGradientBasedCorrections` layers, matching
    /// whichever container the document listed first — Maple's own writer
    /// always emits linear before radial, see [`serialize_local_adjustments`]).
    pub(super) fn finish(self) -> Vec<LocalAdjustment> {
        self.finished
    }
}

/// Emit the canonical `crs:GradientBasedCorrections` /
/// `crs:CircularGradientBasedCorrections` nested child elements for
/// `model.local_adjustments`, each line prefixed so the container element
/// sits at `indent` — same contract as [`super::serialize_tone_curves`].
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

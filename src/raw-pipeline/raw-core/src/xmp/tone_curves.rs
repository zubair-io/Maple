//! Nested-element XMP I/O for the four point tone curves (#365).
//!
//! Every other field on `AdjustmentModel` is a flat attribute on
//! `rdf:Description`, which is why [`super::parse`]'s walker only ever looked
//! at `Event::Empty` / `Event::Start` attribute sets. A point curve is a list,
//! so it takes the RDF container form instead:
//!
//! ```xml
//! <papp:SceneLinearToneCurve>
//!   <rdf:Seq>
//!     <rdf:li>0, 0</rdf:li>
//!     <rdf:li>128, 140</rdf:li>
//!     <rdf:li>255, 255</rdf:li>
//!   </rdf:Seq>
//! </papp:SceneLinearToneCurve>
//! ```
//!
//! **Namespace.** Maple's point curves are authored in the `papp:` namespace,
//! not Adobe's `crs:ToneCurvePV2012*`. The two are different quantities:
//! `#273`'s pipeline foundation applies these curves *pre-AgX*, in scene-linear
//! light, while a `crs:ToneCurvePV2012` curve was authored against Lightroom's
//! own display transform and only means anything *after* a view transform
//! (`docs/maple-paper.md` § 3, "tone curve families"). Reading a Lightroom
//! curve into these fields would apply a display-referred shape to
//! scene-linear data and render the image visibly wrong, so the `crs:` keys
//! are deliberately NOT parsed here — they survive a read-modify-write through
//! the writers' unknown-node passthrough instead. Consuming them properly is a
//! separate display-referred pipeline slot (see `docs/xmp-canonical-format.md`
//! § "Tone curves").
//!
//! **Wire domain.** Control points are stored on the model in `[0, 1]` and
//! written in PV2012's `[0, 255]` domain, matching the paper. The scale factor
//! is applied at this boundary only — [`crate::types::ToneCurve`] never sees
//! the wire encoding.
//!
//! **Identity is silence.** The identity curve is the empty point list, and it
//! serializes to no element at all — not to an empty `rdf:Seq` — so a sidecar
//! for an unedited image stays byte-identical to what the pre-#365 writers
//! produced.

use super::AdjustmentModel;
use crate::types::adjustment::ToneCurve;

/// The four curve parent elements, in canonical emit order.
pub(super) const CURVE_ELEMENTS: [&str; 4] = [
    "papp:SceneLinearToneCurve",
    "papp:SceneLinearToneCurveRed",
    "papp:SceneLinearToneCurveGreen",
    "papp:SceneLinearToneCurveBlue",
];

/// Wire domain of a control-point coordinate. PV2012 convention, kept for
/// familiarity and for Lightroom-shaped tooling that inspects sidecars.
const WIRE_SCALE: f32 = 255.0;

fn curve_slot(m: &mut AdjustmentModel, index: usize) -> &mut ToneCurve {
    match index {
        0 => &mut m.tone_curve_luma,
        1 => &mut m.tone_curve_red,
        2 => &mut m.tone_curve_green,
        _ => &mut m.tone_curve_blue,
    }
}

fn curve_ref(m: &AdjustmentModel, index: usize) -> &ToneCurve {
    match index {
        0 => &m.tone_curve_luma,
        1 => &m.tone_curve_red,
        2 => &m.tone_curve_green,
        _ => &m.tone_curve_blue,
    }
}

/// True when `name` is the `rdf:li` element regardless of the bound prefix.
/// The RDF prefix is not fixed by the spec — a valid sidecar may bind it to
/// anything — and the Swift / TypeScript parsers already match `rdf:li` on
/// its local name, so this keeps the three walkers agreeing on foreign input.
fn is_li(name: &str) -> bool {
    name == "li" || name.ends_with(":li")
}

/// Decode one `<rdf:li>x, y</rdf:li>` body into a `[0, 1]` control point.
/// Returns `None` for anything that is not a numeric pair — a malformed
/// entry is dropped rather than failing the whole parse, matching how the
/// walker treats every other unrecognised construct in the document.
fn parse_point(text: &str) -> Option<(f32, f32)> {
    let (x, y) = text.split_once(',')?;
    let x: f32 = x.trim().parse().ok()?;
    let y: f32 = y.trim().parse().ok()?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some((x / WIRE_SCALE, y / WIRE_SCALE))
}

/// Format one coordinate back into the wire domain through the canonical
/// number codec (`docs/xmp-canonical-format.md` § "Number formatting"):
/// round to two decimals, integers without a trailing `.0`. Rust's `Display`
/// for `f32` already emits the shortest round-tripping form, so `128.0`
/// prints as `128` and `0.5` as `0.5`.
fn fmt_coord(v: f32) -> String {
    let wire = ((v * WIRE_SCALE) * 100.0).round() / 100.0;
    format!("{wire}")
}

/// Incremental state for the nested-element walk driven by [`super::parse`].
///
/// The walker is deliberately a small state machine rather than a general
/// nested-schema engine: four known parents, one known container, one known
/// leaf. Anything else in the document is untouched.
#[derive(Default)]
pub(super) struct CurveWalker {
    /// Index into [`CURVE_ELEMENTS`] of the parent element being read.
    active: Option<usize>,
    points: Vec<(f32, f32)>,
    /// Accumulates `rdf:li` text; `XMLParser`-style chunked delivery means a
    /// single leaf can arrive as several text events.
    li_text: Option<String>,
}

impl CurveWalker {
    /// Handle an element opening. Returns `true` when the element is part of
    /// a tone-curve subtree, in which case the caller skips its attribute
    /// walk — these elements carry no Maple attributes.
    pub(super) fn start(&mut self, name: &str) -> bool {
        if let Some(index) = CURVE_ELEMENTS.iter().position(|e| *e == name) {
            self.active = Some(index);
            self.points.clear();
            self.li_text = None;
            return true;
        }
        if self.active.is_none() {
            return false;
        }
        if is_li(name) {
            self.li_text = Some(String::new());
        }
        // `rdf:Seq` (or any other wrapper) carries no value of its own.
        true
    }

    /// Accumulate text content while inside an `rdf:li`.
    pub(super) fn text(&mut self, chunk: &str) {
        if let Some(buf) = self.li_text.as_mut() {
            buf.push_str(chunk);
        }
    }

    /// Handle an element closing, committing the finished curve onto `model`
    /// when the parent element ends.
    pub(super) fn end(&mut self, name: &str, model: &mut AdjustmentModel) {
        let Some(index) = self.active else { return };
        if is_li(name) {
            if let Some(text) = self.li_text.take() {
                if let Some(point) = parse_point(&text) {
                    self.points.push(point);
                }
            }
            return;
        }
        if CURVE_ELEMENTS[index] == name {
            *curve_slot(model, index) = ToneCurve::new(std::mem::take(&mut self.points));
            self.active = None;
            self.li_text = None;
        }
    }
}

/// Emit the nested tone-curve child elements for `model`, each line prefixed
/// so the parent element sits at `indent`.
///
/// `indent` is a parameter because the three writers nest `rdf:Description`'s
/// children at different depths today (Swift at six spaces, TypeScript at
/// two); the block's internal shape is identical everywhere, which is what
/// the cross-language parity tests pin.
///
/// Returns the empty string when all four curves are identity, so an unedited
/// model adds nothing to the document and the `rdf:Description` stays
/// self-closing.
pub fn serialize_tone_curves(model: &AdjustmentModel, indent: &str) -> String {
    let mut out = String::new();
    for index in 0..CURVE_ELEMENTS.len() {
        let curve = curve_ref(model, index);
        if curve.is_identity() {
            continue;
        }
        let element = CURVE_ELEMENTS[index];
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("{indent}<{element}>\n"));
        out.push_str(&format!("{indent}  <rdf:Seq>\n"));
        for (x, y) in &curve.points {
            out.push_str(&format!(
                "{indent}    <rdf:li>{}, {}</rdf:li>\n",
                fmt_coord(*x),
                fmt_coord(*y)
            ));
        }
        out.push_str(&format!("{indent}  </rdf:Seq>\n"));
        out.push_str(&format!("{indent}</{element}>"));
    }
    out
}

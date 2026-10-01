//! Current adjustment XML traversal; workflow records are opaque (#4043).
use super::*;
use quick_xml::events::Event;
use quick_xml::reader::Reader;

/// Parse a `crs:`-style XMP sidecar. Unknown fields are ignored; known fields that
/// fail to parse numerically surface as an error.
///
/// Crop fields (`crs:CropTop/Left/Bottom/Right/Angle`) are gated by
/// `crs:HasCrop`: when the marker is `"False"` or absent the parser
/// ignores any `crs:Crop*` values and leaves the identity default.
/// `crs:CropAngle` is independent of `HasCrop` (a pure straighten can be
/// serialized without the other four crop edges — spec § 01 invariant 3).
/// The parser does two passes per element so attribute order is irrelevant.
pub fn parse(xml: &str) -> Result<AdjustmentModel> {
    let mut model = AdjustmentModel::default();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    // WB scale versioning (#1780) — document-level state. `papp_seen`
    // records whether ANY element carries the Maple `papp:` namespace
    // (declaration or attribute); every Maple writer declares it
    // unconditionally, so its presence identifies a Maple-authored sidecar.
    // The prefix (not a URI) is the discriminator because the three Maple
    // writers historically bound `papp` to different URIs, while all three
    // parsers key attribute lookups on the `papp:` prefix. An explicit
    // `papp:WbScaleVersion` stamp always wins; a Maple-authored document
    // without one that carries an explicit `crs:Temperature`/`crs:Tint`
    // predates the versioning (pre-#1756 scale, V1); everything else — a
    // document with no `papp:` namespace at all (ACR/Lightroom-authored,
    // always expressed in ACR's own slider scale) or one with no authored
    // WB (nothing to convert; scale-agnostic) — is V5 (#1894).
    let mut papp_seen = false;
    let mut stamp: Option<WbScaleVersion> = None;
    // Persisted authoring records are never current development attributes.
    // Their scoped namespace must not reclassify foreign WB as legacy Maple.
    let mut workflow_depth = 0usize;
    // Point tone curves (#365) are the one part of the schema that is not a
    // flat attribute — they are nested `rdf:Seq` / `rdf:li` content under the
    // four `papp:SceneLinearToneCurve*` parents. The walker owns that subtree;
    // everything outside it still goes through the attribute path below.
    let mut curves = CurveWalker::default();
    // Local adjustments (#358) are the other non-flat part of the schema —
    // see `local_adjustments/` for the canonical `crs:GradientBasedCorrections`
    // / `crs:CircularGradientBasedCorrections` shape this walks.
    let mut local_adj = LocalAdjustmentsWalker::default();
    // Repair spots (#3409) — the third non-flat part of the schema. See
    // `retouch/` for the `crs:RetouchAreas` shape it walks and the legacy
    // `crs:RetouchInfo` string form it also accepts.
    let mut retouch = RetouchWalker::default();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = element_name(&e)?.to_string();
                if workflow_depth > 0 || name == "papp:Workflow" {
                    workflow_depth += 1;
                    continue;
                }
                // Inside a tone-curve or local-adjustments subtree there are
                // no flat Maple attributes to read, so the attribute walk is
                // skipped entirely for elements either walker claims.
                if local_adj.start(&name, &e)? || retouch.start(&name, &e)? {
                    // handled
                } else if !curves.start(&name) {
                    apply_attributes(&e, &mut model, &mut papp_seen, &mut stamp)?;
                }
            }
            Ok(Event::Empty(e)) => {
                let name = element_name(&e)?.to_string();
                if workflow_depth > 0 || name == "papp:Workflow" {
                    continue;
                }
                if !local_adj.empty(&name, &e)? && !retouch.empty(&name, &e)? {
                    apply_attributes(&e, &mut model, &mut papp_seen, &mut stamp)?;
                }
            }
            Ok(Event::Text(t)) => {
                if workflow_depth > 0 {
                    continue;
                }
                let text = t.unescape().map_err(|e| Error::Xmp(e.to_string()))?;
                curves.text(&text);
                retouch.text(&text);
            }
            Ok(Event::End(e)) => {
                if workflow_depth > 0 {
                    workflow_depth -= 1;
                    continue;
                }
                let name = std::str::from_utf8(e.name().as_ref())
                    .map_err(|e| Error::Xmp(e.to_string()))?
                    .to_string();
                local_adj.end(&name);
                retouch.end(&name);
                curves.end(&name, &mut model);
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::Xmp(e.to_string())),
            _ => {}
        }
    }
    // Canonical nested form wins over the legacy `papp:LocalAdjustments`
    // attribute (applied above, mid-loop, via `fields::set_field`) whenever
    // this walker collected at least one layer — see the migration-precedence
    // note in `local_adjustments/` and `docs/xmp-canonical-format.md` §
    // "Local adjustments".
    let canonical_layers = local_adj.finish();
    if !canonical_layers.is_empty() {
        model.local_adjustments = canonical_layers;
    }
    retouch.finish(&mut model);
    model.inpaint_removals = removal_records::parse(xml)?;
    let unstamped_is_v1 = papp_seen && (model.temperature_seen || model.tint_seen);
    // Unstamped, non-Maple (or WB-less) documents are V5 (#1894): an
    // ACR/Lightroom-authored crs:Tint is expressed in ACR's own convention,
    // which IS the Robertson mapping V5 evaluates on — ACR derives its
    // displayed temperature/tint pair from exactly this table — so it
    // passes through unconverted. (These parsed as V4 between #1893 and
    // #1894, when the direction and magnitude were matched but the
    // evaluation locus was still the legacy Hernández-Andrés curve rather
    // than Robertson; the V4 tag now exists solely to preserve the look of
    // any dev-window V4 sidecar via `authored_pair_to_v5`'s joint
    // chromaticity round-trip, the same role V2/V3 play for their scales.)
    model.wb_scale_version = stamp.unwrap_or(if unstamped_is_v1 {
        WbScaleVersion::V1
    } else {
        WbScaleVersion::V5
    });
    Ok(model)
}

//! XMP parser tests — `papp:WbScaleVersion` / WB-scale authorship
//! heuristic (#1780). Split into a sibling file because `tests_modes.rs`
//! sits at the 600-LOC cap.

#![cfg(test)]

use super::*;

/// Maple-shaped envelope: `xmlns:papp` declared (all three Maple writers
/// declare it unconditionally), plus whatever attributes the test splices.
fn maple_doc(attrs: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:papp="http://ns.justmaple.app/1.0/"
      {attrs}/>
  </rdf:RDF>
</x:xmpmeta>"#
    )
}

/// ACR-shaped envelope: `crs:` only, no Maple namespace anywhere —
/// matches the committed `test-fixtures/references/*/xmp/*.xmp` corpus.
fn acr_doc(attrs: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   {attrs}/>
 </rdf:RDF>
</x:xmpmeta>"#
    )
}

#[test]
fn default_model_is_v4() {
    assert_eq!(
        AdjustmentModel::default().wb_scale_version,
        WbScaleVersion::V4,
        "fresh models author in the current (ACR direction + kTintScale) scale"
    );
}

#[test]
fn maple_authored_without_stamp_is_v1() {
    // Pre-#1780 Maple sidecar: papp namespace declared, no stamp — the
    // stored WB numbers predate #1756's scale change.
    let m = parse(&maple_doc(r#"crs:Temperature="6282" crs:Tint="-44""#)).unwrap();
    assert_eq!(m.wb_scale_version, WbScaleVersion::V1);
    assert!(m.temperature_seen && m.tint_seen);
    assert_eq!(m.temperature, 6282.0);
    assert_eq!(m.tint, -44.0);
}

#[test]
fn maple_authorship_detected_from_papp_attribute_without_declaration() {
    // Defensive: a doc that carries a `papp:`-prefixed attribute without
    // the xmlns declaration is still Maple-authored.
    let m =
        parse(r#"<rdf:Description xmlns:rdf="x" papp:Profile="Neutral" crs:Temperature="5000"/>"#)
            .unwrap();
    assert_eq!(m.wb_scale_version, WbScaleVersion::V1);
}

#[test]
fn acr_authored_without_papp_is_v4() {
    // ACR/Lightroom-authored sidecars never carry the Maple namespace and
    // are expressed in ACR's own convention — the V4 direction (#1875) AND
    // magnitude (kTintScale, #1893) — so they pass through unconverted.
    // (They classified as V3 between #1875 and #1893, which under-applied
    // ACR tints 3.33x.)
    let m = parse(&acr_doc(r#"crs:Temperature="5500" crs:Tint="10""#)).unwrap();
    assert_eq!(m.wb_scale_version, WbScaleVersion::V4);
    assert!(m.temperature_seen && m.tint_seen);
}

#[test]
fn explicit_stamp_2_wins_over_the_maple_heuristic() {
    let m = parse(&maple_doc(
        r#"crs:Temperature="5700" papp:WbScaleVersion="2""#,
    ))
    .unwrap();
    assert_eq!(m.wb_scale_version, WbScaleVersion::V2);
}

#[test]
fn explicit_stamp_1_round_trips_v1() {
    // Post-#1780 writers stamp the version they loaded, so a V1 sidecar
    // re-saved by a new build carries an explicit "1".
    let m = parse(&maple_doc(
        r#"crs:Temperature="6282" crs:Tint="-44" papp:WbScaleVersion="1""#,
    ))
    .unwrap();
    assert_eq!(m.wb_scale_version, WbScaleVersion::V1);
}

#[test]
fn explicit_stamp_3_is_v3() {
    let m = parse(&maple_doc(
        r#"crs:Temperature="5520" crs:Tint="-144" papp:WbScaleVersion="3""#,
    ))
    .unwrap();
    assert_eq!(m.wb_scale_version, WbScaleVersion::V3);
    assert_eq!(m.tint, -144.0);
}

#[test]
fn explicit_stamp_4_is_v4() {
    let m = parse(&maple_doc(
        r#"crs:Temperature="5520" crs:Tint="-53" papp:WbScaleVersion="4""#,
    ))
    .unwrap();
    assert_eq!(m.wb_scale_version, WbScaleVersion::V4);
    assert_eq!(m.tint, -53.0);
}

#[test]
fn unknown_stamp_value_is_an_error() {
    let err = parse(&maple_doc(r#"papp:WbScaleVersion="5""#)).unwrap_err();
    assert!(
        err.to_string().contains("WbScaleVersion"),
        "unexpected error: {err}"
    );
}

#[test]
fn maple_doc_without_explicit_wb_is_v4() {
    // No authored Temperature/Tint = nothing to convert (the develop
    // chain's As-Shot seeding applies on either scale), so the version
    // heuristic deliberately leaves the model at the V4 default — this is
    // also what keeps a full-default serialize→parse round trip equal to
    // `AdjustmentModel::default()`.
    let m = parse(&maple_doc(r#"crs:Exposure2012="0.5""#)).unwrap();
    assert_eq!(m.wb_scale_version, WbScaleVersion::V4);
    assert!(!m.temperature_seen && !m.tint_seen);
    assert_eq!((m.temperature, m.tint), (6500.0, 0.0));
}

#[test]
fn tint_only_maple_doc_is_v1() {
    // A single explicit component is enough — pre-#1756 `resolve_wb`
    // anchored a tint-only Custom WB at 6500 K, so the stored tint is a
    // V1-scale quantity.
    let m = parse(&maple_doc(r#"crs:Tint="-30""#)).unwrap();
    assert_eq!(m.wb_scale_version, WbScaleVersion::V1);
    assert!(!m.temperature_seen && m.tint_seen);
}

//! Batch Metadata field-tolerance test (#1581 / epic #1575), split out of
//! tests.rs to keep both files under the 600-LOC hard cap.
#![cfg(test)]

use super::*;

// -----------------------------------------------------------------------
// Batch Metadata field tolerance (ticket #1581 / epic #1575)
// -----------------------------------------------------------------------

/// A sidecar carrying all 17 Batch Metadata simple attributes + the 5 managed
/// nested elements (dc:title, dc:creator, dc:description, dc:rights,
/// xmpRights:UsageTerms) must parse to an `AdjustmentModel` that is
/// **identical to the default** — none of the metadata fields live in the
/// adjustment model, and the Rust parser's `_ => {}` catch-all arm must
/// silently ignore them without returning an error.
///
/// This is the "Rust tolerance" gate from the M0b spec (spec 2026-06-26).
#[test]
fn parse_ignores_batch_metadata_fields() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:papp="http://ns.justmaple.app/1.0/"
              xmlns:exif="http://ns.adobe.com/exif/1.0/"
              xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
              xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
              xmlns:dc="http://purl.org/dc/elements/1.1/"
              xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
              crs:Exposure2012="1.5"
              exif:GPSLatitude="48,51.3960N"
              exif:GPSLongitude="2,21.1320E"
              exif:GPSAltitude="35000/1000"
              exif:GPSAltitudeRef="0"
              exif:DateTimeOriginal="2026-06-26T18:40:00+02:00"
              papp:TimeZone="Europe/Paris"
              Iptc4xmpCore:Location="Rue Vignon"
              photoshop:City="Paris"
              photoshop:State="Ile-de-France"
              photoshop:Country="France"
              Iptc4xmpCore:CountryCode="FR"
              photoshop:Headline="Trip"
              photoshop:Instructions="Embargo until July"
              photoshop:AuthorsPosition="Photographer"
              photoshop:Credit="Z. Lawrence"
              photoshop:Source="Maple"
              xmpRights:Marked="True">
              <dc:title>
                <rdf:Alt>
                  <rdf:li xml:lang="x-default">Sunset</rdf:li>
                </rdf:Alt>
              </dc:title>
              <dc:creator>
                <rdf:Seq>
                  <rdf:li>Ansel Adams</rdf:li>
                </rdf:Seq>
              </dc:creator>
              <dc:description>
                <rdf:Alt>
                  <rdf:li xml:lang="x-default">Notes here</rdf:li>
                </rdf:Alt>
              </dc:description>
              <dc:rights>
                <rdf:Alt>
                  <rdf:li xml:lang="x-default">All rights reserved</rdf:li>
                </rdf:Alt>
              </dc:rights>
              <xmpRights:UsageTerms>
                <rdf:Alt>
                  <rdf:li xml:lang="x-default">Usage terms here</rdf:li>
                </rdf:Alt>
              </xmpRights:UsageTerms>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>"#;

    // Must parse without error.
    let m = parse(xml).expect("metadata-carrying sidecar must parse without error");

    // The known adjustment field (crs:Exposure2012) must be parsed correctly.
    assert!(
        (m.exposure - 1.5).abs() < 1e-4,
        "crs:Exposure2012 must be parsed: expected 1.5, got {}",
        m.exposure
    );

    // All other fields must remain at their defaults — the metadata attrs/nodes
    // must be silently ignored, not corrupt or reject the parse.
    let d = AdjustmentModel::default();
    assert_eq!(
        m.temperature, d.temperature,
        "temperature must stay default"
    );
    assert_eq!(m.contrast, d.contrast, "contrast must stay default");
    assert_eq!(m.highlights, d.highlights, "highlights must stay default");
    assert_eq!(m.crop.is_identity(), true, "crop must stay identity");
}

// -----------------------------------------------------------------------
// Full-default round-trip assertion (deferred from M0b review, #1611)
// -----------------------------------------------------------------------

/// Serializing a full-default `AdjustmentModel` and parsing the result must
/// yield a model equal to the default. Guards that the Rust `serialize` +
/// `parse` pair are consistent on the identity case — neither step silently
/// corrupts a default field.
///
/// The Rust `serialize` emits only non-default attributes (the full-default
/// model produces an empty fragment). Wrapping that in a minimal XMP envelope
/// and parsing must return a model equal to `AdjustmentModel::default()`.
#[test]
fn full_default_serialize_parse_round_trips() {
    let d = AdjustmentModel::default();
    let frag = serialize(&d);
    let xml = format!(
        r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:papp="http://ns.justmaple.app/1.0/"{frag}/>
          </rdf:RDF>
        </x:xmpmeta>"#
    );
    let parsed = parse(&xml).expect("full-default sidecar must parse without error");
    assert_eq!(
        parsed, d,
        "parsing the serialized full-default must recover the default model"
    );
}

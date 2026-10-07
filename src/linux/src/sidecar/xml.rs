//! Namespace-aware reading and attribute-preserving document writing.
mod parse;
mod write;
pub(super) use parse::parse;
pub(super) use write::serialize;

use super::SidecarError;
use roxmltree::{Document, Node};
use std::ops::Range;

const RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const CRS: &str = "http://ns.adobe.com/camera-raw-settings/1.0/";
const XMP: &str = "http://ns.adobe.com/xap/1.0/";
const PAPP: &str = "http://ns.justmaple.app/photo/1.0/";
const EMPTY: &str = "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n    <rdf:Description rdf:about=\"\"\n      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"/>\n  </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>\n";

fn prefix(namespace: Option<&str>) -> Option<&'static str> {
    match namespace? {
        RDF => Some("rdf"),
        CRS => Some("crs"),
        XMP => Some("xmp"),
        PAPP | "http://ns.justmaple.app/1.0/" | "https://maple.app/ns/1.0/" => Some("papp"),
        _ => None,
    }
}

fn key(namespace: Option<&str>, name: &str) -> Option<String> {
    prefix(namespace).map(|prefix| format!("{prefix}:{name}"))
}

fn descriptions<'a, 'input>(doc: &'a Document<'input>) -> Vec<Node<'a, 'input>> {
    doc.descendants()
        .find(|node| node.has_tag_name((RDF, "RDF")))
        .map(|rdf| {
            rdf.children()
                .filter(|node| node.has_tag_name((RDF, "Description")))
                .collect()
        })
        .unwrap_or_default()
}

fn replace(source: &str, mut changes: Vec<(Range<usize>, String)>) -> String {
    changes.sort_by_key(|(range, _)| range.start);
    let mut result = String::new();
    let mut cursor = 0;
    for (range, value) in changes {
        result.push_str(&source[cursor..range.start]);
        result.push_str(&value);
        cursor = range.end;
    }
    result.push_str(&source[cursor..]);
    result
}

fn start_tag_end(source: &str) -> Result<usize, SidecarError> {
    let mut quote = None;
    for (index, ch) in source.char_indices() {
        match (quote, ch) {
            (None, '\'' | '"') => quote = Some(ch),
            (Some(open), close) if open == close => quote = None,
            (None, '>') => return Ok(index + 1),
            _ => {}
        }
    }
    Err(SidecarError::Invalid("Unterminated XML start tag".into()))
}

/// Out-of-range ratings (Lightroom's `-1` reject) read as unrated; `3.0` reads as 3.
fn rating_value(value: &str) -> u8 {
    value
        .trim()
        .parse::<f32>()
        .ok()
        .filter(|rating| rating.is_finite())
        .map_or(0, |rating| rating.round().clamp(0.0, 5.0) as u8)
}

mod reset;
pub(super) use reset::reset;

//! The primary `rdf:Description` as a set of properties with exact source
//! spans (#4983): each attribute and each top-level child element.
use quick_xml::{events::Event, reader::NsReader};
use std::collections::HashMap;
use std::ops::Range;

pub(super) struct Property {
    pub(super) key: String,
    /// Attribute: the raw value text. Child element: the element's source text.
    pub(super) value: String,
    /// Attribute: `key="value"`. Child element: `<…>…</…>`.
    pub(super) span: Range<usize>,
    /// The whitespace run directly before `span`.
    pub(super) lead: Range<usize>,
}

pub(super) struct Description<'a> {
    pub(super) xml: &'a str,
    pub(super) open: Range<usize>,
    pub(super) self_closing: bool,
    pub(super) close: Option<Range<usize>>,
    pub(super) attributes: Vec<Property>,
    pub(super) children: Vec<Property>,
}

fn is_rdf_path(path: &[String]) -> bool {
    path == ["x:xmpmeta", "rdf:RDF"] || path == ["rdf:RDF"]
}

fn is_description_path(path: &[String]) -> bool {
    path == ["x:xmpmeta", "rdf:RDF", "rdf:Description"] || path == ["rdf:RDF", "rdf:Description"]
}

impl<'a> Description<'a> {
    pub(super) fn parse(xml: &'a str) -> Result<Self, String> {
        let mut reader = NsReader::from_str(xml);
        let mut path: Vec<String> = Vec::new();
        let mut open = None;
        let mut self_closing = false;
        let mut close = None;
        let mut done = false;
        let mut spans: Vec<(String, Range<usize>)> = Vec::new();
        let mut child_start = None;
        loop {
            let start = reader.buffer_position() as usize;
            let event = reader.read_event().map_err(|e| e.to_string())?;
            let end = reader.buffer_position() as usize;
            match &event {
                Event::Start(e) | Event::Empty(e) => {
                    let name = std::str::from_utf8(e.name().as_ref())
                        .map_err(|e| e.to_string())?
                        .to_owned();
                    let is_start = matches!(event, Event::Start(_));
                    if name == "rdf:Description" && open.is_none() && is_rdf_path(&path) {
                        open = Some(start..end);
                        self_closing = !is_start;
                        done = self_closing;
                    } else if open.is_some() && !done && is_description_path(&path) {
                        if is_start {
                            child_start = Some((name.clone(), start));
                        } else {
                            spans.push((name.clone(), start..end));
                        }
                    }
                    if is_start {
                        path.push(name);
                    }
                }
                Event::End(_) => {
                    path.pop();
                    if open.is_some() && !done {
                        if is_description_path(&path) {
                            if let Some((name, begin)) = child_start.take() {
                                spans.push((name, begin..end));
                            }
                        } else if is_rdf_path(&path) {
                            close = Some(start..end);
                            done = true;
                        }
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
        let open = open.ok_or("missing primary XMP description")?;
        let attributes = attributes(xml, &open)?;
        let mut ordinals: HashMap<String, usize> = HashMap::new();
        let children = spans
            .into_iter()
            .map(|(name, span)| {
                let ordinal = ordinals.entry(name.clone()).or_default();
                let key = format!("{name}#{ordinal}");
                *ordinal += 1;
                Property {
                    key,
                    value: xml[span.clone()].to_owned(),
                    lead: leading_whitespace(xml, span.start),
                    span,
                }
            })
            .collect();
        Ok(Self {
            xml,
            open,
            self_closing,
            close,
            attributes,
            children,
        })
    }

    /// Offset just past the tag name, where a first attribute may go.
    pub(super) fn after_tag_name(&self) -> usize {
        let name = self.xml[self.open.clone()]
            .bytes()
            .skip(1)
            .take_while(|b| !b.is_ascii_whitespace() && !matches!(b, b'/' | b'>'))
            .count();
        self.open.start + 1 + name
    }
}

pub(super) fn leading_whitespace(xml: &str, at: usize) -> Range<usize> {
    let trimmed = xml[..at].trim_end_matches(|c: char| c.is_ascii_whitespace());
    trimmed.len()..at
}

/// Tokenize the opening tag so each attribute keeps its exact source span.
fn attributes(xml: &str, open: &Range<usize>) -> Result<Vec<Property>, String> {
    let tag = &xml[open.clone()];
    let bytes = tag.as_bytes();
    let mut at = 1;
    while at < bytes.len() && !bytes[at].is_ascii_whitespace() && !matches!(bytes[at], b'/' | b'>')
    {
        at += 1;
    }
    let mut out = Vec::new();
    loop {
        let lead = at;
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if at >= bytes.len() || matches!(bytes[at], b'/' | b'>') {
            return Ok(out);
        }
        let key_start = at;
        while at < bytes.len() && !bytes[at].is_ascii_whitespace() && bytes[at] != b'=' {
            at += 1;
        }
        let key = &tag[key_start..at];
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if bytes.get(at) != Some(&b'=') {
            return Err("malformed attribute in primary description".into());
        }
        at += 1;
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        let quote = *bytes.get(at).ok_or("unterminated attribute")?;
        if !matches!(quote, b'"' | b'\'') {
            return Err("unquoted attribute in primary description".into());
        }
        let value_start = at + 1;
        let length = tag[value_start..]
            .find(quote as char)
            .ok_or("unterminated attribute value")?;
        at = value_start + length + 1;
        out.push(Property {
            key: key.to_owned(),
            value: tag[value_start..value_start + length].to_owned(),
            span: open.start + key_start..open.start + at,
            lead: open.start + lead..open.start + key_start,
        });
    }
}

pub(super) fn table(properties: &[Property]) -> HashMap<&str, &str> {
    properties
        .iter()
        .map(|p| (p.key.as_str(), p.value.as_str()))
        .collect()
}

//! Removal ownership follows the namespace URI, never a host-specific prefix.
use crate::{
    error::{Error, Result},
    types::inpaint::{decode_removals, Removal},
};
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};

fn owned(namespace: ResolveResult<'_>) -> Result<bool> {
    match namespace {
        ResolveResult::Bound(uri) => Ok(matches!(
            uri.as_ref(),
            b"http://ns.justmaple.app/photo/1.0/" | b"http://ns.justmaple.app/1.0/"
        )),
        ResolveResult::Unbound => Ok(false),
        ResolveResult::Unknown(_) => Err(Error::Xmp(
            "InpaintRemovals has an undeclared namespace prefix".into(),
        )),
    }
}

fn accept(records: &mut Option<Vec<Removal>>, text: &str) -> Result<()> {
    if records.is_some() {
        return Err(Error::Xmp("conflicting InpaintRemovals fields".into()));
    }
    *records =
        Some(decode_removals(text).map_err(|e| Error::Xmp(format!("InpaintRemovals: {e}")))?);
    Ok(())
}

/// Canonical attributes and equivalent scalar property elements share exactly
/// one owned list. Foreign fields stay opaque; ambiguous or nested payloads
/// cannot turn an accepted edit into a partial list or an unedited render.
pub(super) fn parse(xml: &str) -> Result<Vec<Removal>> {
    let mut reader = NsReader::from_str(xml);
    let mut buffer = Vec::new();
    let mut records = None;
    let mut text: Option<String> = None;
    let mut descriptions = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| Error::Xmp(e.to_string()))?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                if text.is_some() {
                    return Err(Error::Xmp(
                        "InpaintRemovals must contain scalar JSON, not nested XML".into(),
                    ));
                }
                let (namespace, local) = reader.resolve_element(tag.name());
                let is_description = local.as_ref() == b"Description"
                    && matches!(namespace, ResolveResult::Bound(uri)
                        if uri.as_ref() == b"http://www.w3.org/1999/02/22-rdf-syntax-ns#");
                for attribute in tag.attributes().filter(|_| is_description) {
                    let attribute = attribute.map_err(|e| Error::Xmp(e.to_string()))?;
                    let (namespace, local) = reader.resolve_attribute(attribute.key);
                    if local.as_ref() == b"InpaintRemovals" && owned(namespace)? {
                        let value = attribute
                            .decode_and_unescape_value(reader.decoder())
                            .map_err(|e| Error::Xmp(e.to_string()))?;
                        accept(&mut records, &value)?;
                    }
                }
                let (namespace, local) = reader.resolve_element(tag.name());
                if descriptions.last() == Some(&true)
                    && local.as_ref() == b"InpaintRemovals"
                    && owned(namespace)?
                {
                    if empty {
                        accept(&mut records, "")?;
                    } else {
                        text = Some(String::new());
                    }
                }
                if !empty {
                    descriptions.push(is_description);
                }
            }
            Event::Text(value) => {
                if let Some(text) = text.as_mut() {
                    text.push_str(&value.unescape().map_err(|e| Error::Xmp(e.to_string()))?);
                }
            }
            Event::CData(value) => {
                if let Some(text) = text.as_mut() {
                    text.push_str(
                        &reader
                            .decoder()
                            .decode(value.as_ref())
                            .map_err(|e| Error::Xmp(e.to_string()))?,
                    );
                }
            }
            Event::End(_) => {
                if let Some(value) = text.take() {
                    accept(&mut records, &value)?;
                }
                descriptions.pop();
            }
            Event::Eof => {
                if text.is_some() {
                    return Err(Error::Xmp("unclosed InpaintRemovals field".into()));
                }
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(records.unwrap_or_default())
}

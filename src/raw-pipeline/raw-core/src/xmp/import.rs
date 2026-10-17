//! Namespace-aware import without a DOM or a second full XML document.
use super::import_validation::{instruction_name, qualified_name, validate, xml_declaration};
use super::reader::parse_events;
use crate::error::{Error, Result};
use crate::types::adjustment::{AdjustmentModel, TRANSFER_XMP_ATTRIBUTES, TRANSFER_XMP_ELEMENTS};
use quick_xml::{
    events::{BytesEnd, BytesStart, BytesText, Event},
    name::{LocalName, ResolveResult},
    NsReader,
};

fn prefix(uri: &[u8]) -> Option<&'static str> {
    let text = std::str::from_utf8(uri).ok()?;
    let decoded = quick_xml::escape::unescape(text).ok()?;
    match decoded.as_bytes() {
        b"http://www.w3.org/1999/02/22-rdf-syntax-ns#" => Some("rdf"),
        b"http://ns.adobe.com/camera-raw-settings/1.0/" => Some("crs"),
        b"http://ns.justmaple.app/photo/1.0/"
        | b"http://ns.justmaple.app/1.0/"
        | b"https://maple.app/ns/1.0/" => Some("papp"),
        _ => None,
    }
}

fn prefixed_name(prefix: &str, local: &LocalName<'_>) -> Result<String> {
    std::str::from_utf8(local.as_ref())
        .map(|local| format!("{prefix}:{local}"))
        .map_err(|error| Error::Xmp(error.to_string()))
}

fn canonical_name(resolved: ResolveResult<'_>, local: &LocalName<'_>) -> Result<Option<String>> {
    match resolved {
        ResolveResult::Bound(uri) => prefix(uri.as_ref())
            .map(|prefix| prefixed_name(prefix, local))
            .transpose(),
        ResolveResult::Unbound => Ok(None),
        ResolveResult::Unknown(_) => Err(Error::Xmp("Undeclared XML namespace prefix".into())),
    }
}

fn flat_key(key: &str) -> bool {
    TRANSFER_XMP_ATTRIBUTES
        .iter()
        .any(|(_, keys)| keys.contains(&key))
        || matches!(
            key,
            "crs:WhiteBalance"
                | "papp:WbScaleVersion"
                | "papp:InpaintRemovals"
                | "papp:LensProfile"
                | "papp:LocalAdjustments"
        )
}

fn container(name: &str) -> bool {
    TRANSFER_XMP_ELEMENTS.iter().any(|(_, key)| *key == name)
        || matches!(
            name,
            "crs:GradientBasedCorrections"
                | "crs:CircularGradientBasedCorrections"
                | "crs:MaskGroupBasedCorrections"
                | "crs:RetouchAreas"
                | "crs:RetouchInfo"
                | "papp:BrushCorrections"
        )
}

#[derive(Clone, Copy, PartialEq)]
enum Scope {
    Outside,
    Description,
    Develop,
    Unowned,
    Opaque,
}
struct Frame {
    name: Option<String>,
    scope: Scope,
}

struct Import<'a> {
    reader: NsReader<&'a [u8]>,
    frames: Vec<Frame>,
    roots: usize,
    finished: bool,
}

impl<'a> Import<'a> {
    fn new(xml: &'a str) -> Self {
        let mut reader = NsReader::from_str(xml);
        reader.config_mut().trim_text(true);
        reader.config_mut().check_comments = true;
        Self {
            reader,
            frames: Vec::new(),
            roots: 0,
            finished: false,
        }
    }

    fn start(&mut self, source: &BytesStart<'a>, empty: bool) -> Result<Option<Event<'a>>> {
        qualified_name(source.name().as_ref())?;
        if self.frames.is_empty() {
            self.roots += 1;
            if self.roots > 1 {
                return Err(Error::Xmp("Multiple XML roots".into()));
            }
        }
        let (resolved, local) = self.reader.resolve_element(source.name());
        let foreign = matches!(resolved, ResolveResult::Bound(_));
        let owned_name = canonical_name(resolved, &local)?;
        let parent = self.frames.last();
        let parent_scope = parent.map_or(Scope::Outside, |frame| frame.scope);
        let description = owned_name.as_deref() == Some("rdf:Description")
            && parent_scope != Scope::Opaque
            && parent.is_none_or(|frame| frame.name.as_deref() == Some("rdf:RDF"));
        let in_mask_list = self
            .frames
            .iter()
            .any(|frame| frame.name.as_deref() == Some("crs:CorrectionMasks"));
        let scope = if matches!(parent_scope, Scope::Opaque | Scope::Unowned) {
            Scope::Opaque
        } else if description {
            Scope::Description
        } else if parent_scope == Scope::Description {
            if owned_name.as_deref().is_some_and(container) {
                Scope::Develop
            } else {
                Scope::Opaque
            }
        } else if parent_scope == Scope::Develop {
            if owned_name.is_some() && owned_name.as_deref() != Some("papp:Workflow") {
                Scope::Develop
            } else if owned_name.is_none() && foreign && in_mask_list {
                // The walker drops a mask group on `unowned:li`, exactly as the
                // fragment reader surfaces a foreign component (#4691).
                Scope::Unowned
            } else {
                Scope::Opaque
            }
        } else {
            Scope::Outside
        };
        let name = if scope == Scope::Unowned {
            Some(prefixed_name("unowned", &local)?)
        } else {
            owned_name
        };
        let emit = matches!(scope, Scope::Description | Scope::Develop | Scope::Unowned);
        let mut normalized = BytesStart::new(name.clone().unwrap_or_default());
        if scope == Scope::Description
            && self
                .reader
                .prefixes()
                .any(|(_, uri)| prefix(uri.as_ref()) == Some("papp"))
        {
            // Namespace scope identifies unstamped legacy Maple WB, even when
            // the writer chose a different prefix or declared it on an ancestor.
            normalized.push_attribute(("xmlns:papp", "http://ns.justmaple.app/photo/1.0/"));
        }
        for attribute in source.attributes() {
            let attribute = attribute.map_err(|error| Error::Xmp(error.to_string()))?;
            validate(attribute.value.as_ref(), true)?;
            let raw = attribute.key.as_ref();
            qualified_name(raw)?;
            if attribute.value.contains(&b'<') {
                return Err(Error::Xmp("Unescaped XML attribute delimiter".into()));
            }
            if raw == b"xmlns" || raw.starts_with(b"xmlns:") {
                continue;
            }
            let (resolved, local) = self.reader.resolve_attribute(attribute.key);
            if let Some(key) = canonical_name(resolved, &local)? {
                let owned = key.starts_with("crs:") || key.starts_with("papp:");
                let applies = match scope {
                    Scope::Develop => true,
                    Scope::Description => flat_key(&key),
                    Scope::Outside | Scope::Unowned | Scope::Opaque => false,
                };
                if owned && applies {
                    // Values remain escaped and borrowed until this small element
                    // is consumed. Opaque metadata never becomes a duplicate string.
                    normalized.push_attribute((key.as_bytes(), attribute.value.as_ref()));
                }
            }
        }
        if !empty {
            self.frames.push(Frame { name, scope });
        }
        if emit {
            Ok(Some(if empty {
                Event::Empty(normalized.into_owned())
            } else {
                Event::Start(normalized.into_owned())
            }))
        } else {
            Ok(None)
        }
    }

    fn event(&mut self) -> Result<Option<Event<'a>>> {
        loop {
            match self
                .reader
                .read_event()
                .map_err(|error| Error::Xmp(error.to_string()))?
            {
                Event::Start(element) => {
                    if let Some(event) = self.start(&element, false)? {
                        return Ok(Some(event));
                    }
                }
                Event::Empty(element) => {
                    if let Some(event) = self.start(&element, true)? {
                        return Ok(Some(event));
                    }
                }
                Event::End(_) => {
                    let frame = self
                        .frames
                        .pop()
                        .ok_or_else(|| Error::Xmp("Unexpected XML close".into()))?;
                    if matches!(
                        frame.scope,
                        Scope::Description | Scope::Develop | Scope::Unowned
                    ) {
                        return Ok(Some(Event::End(BytesEnd::new(frame.name.unwrap()))));
                    }
                }
                Event::Text(text) => {
                    validate(text.as_ref(), true)?;
                    if text.windows(3).any(|bytes| bytes == b"]]>") {
                        return Err(Error::Xmp("CDATA delimiter in XML text".into()));
                    }
                    if self.frames.is_empty() && !text.is_empty() {
                        return Err(Error::Xmp("Text outside XML root".into()));
                    }
                    if self
                        .frames
                        .last()
                        .is_some_and(|frame| frame.scope == Scope::Develop)
                    {
                        return Ok(Some(Event::Text(text)));
                    }
                }
                Event::CData(text) => {
                    validate(text.as_ref(), false)?;
                    if self.frames.is_empty() {
                        return Err(Error::Xmp("CDATA outside XML root".into()));
                    }
                    if self
                        .frames
                        .last()
                        .is_some_and(|frame| frame.scope == Scope::Develop)
                    {
                        let text = std::str::from_utf8(text.as_ref())
                            .map_err(|error| Error::Xmp(error.to_string()))?;
                        return Ok(Some(Event::Text(BytesText::new(text).into_owned())));
                    }
                }
                Event::DocType(_) => return Err(Error::Xmp("DTD is not supported in XMP".into())),
                Event::Decl(declaration) => {
                    let end = self.reader.buffer_position();
                    // NsReader's byte position excludes its consumed UTF-8 BOM.
                    if end != declaration.len() as u64 + 4 {
                        return Err(Error::Xmp("Misplaced XML declaration".into()));
                    }
                    xml_declaration(&declaration)?;
                }
                Event::Comment(text) => validate(text.as_ref(), false)?,
                Event::PI(instruction) => {
                    instruction_name(instruction.target())?;
                    validate(instruction.as_ref(), false)?;
                    if instruction.target().eq_ignore_ascii_case(b"xml") {
                        return Err(Error::Xmp("Reserved XML instruction target".into()));
                    }
                }
                Event::Eof => {
                    if self.roots != 1 || !self.frames.is_empty() {
                        return Err(Error::Xmp("Incomplete XML document".into()));
                    }
                    return Ok(None);
                }
            }
        }
    }
}

impl<'a> Iterator for Import<'a> {
    type Item = Result<Event<'a>>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        match self.event() {
            Ok(Some(event)) => Some(Ok(event)),
            Ok(None) => {
                self.finished = true;
                None
            }
            Err(error) => {
                self.finished = true;
                Some(Err(error))
            }
        }
    }
}

/// Import complete namespace-qualified XMP through the same adjustment walkers
/// as `parse`, retaining only current develop properties. Source XML stays borrowed.
/// The legacy fragment reader remains available to existing canonical callers.
pub fn parse_namespaced(xml: &str) -> Result<AdjustmentModel> {
    if xml.is_empty() {
        return Ok(AdjustmentModel::default());
    }
    parse_events(Import::new(xml))
}

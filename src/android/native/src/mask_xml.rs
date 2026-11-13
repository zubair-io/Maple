//! A namespace-resolved element tree over the mask containers' source text,
//! keeping every element's byte span so unmodelled XML can be re-emitted
//! exactly as it was read.
use quick_xml::events::Event;
use quick_xml::name::{QName, ResolveResult};
use quick_xml::NsReader;
use std::collections::BTreeMap;
use std::ops::Range;

pub const RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
pub const CRS: &str = "http://ns.adobe.com/camera-raw-settings/1.0/";
pub const PAPP: &str = "http://ns.justmaple.app/photo/1.0/";
const LEGACY_PAPP: [&str; 2] = ["http://ns.justmaple.app/1.0/", "https://maple.app/ns/1.0/"];
const XML: &str = "http://www.w3.org/XML/1998/namespace";

/// The prefixes canonical output is written under, and their namespaces.
pub const CANONICAL: [(&str, &str); 3] = [("rdf", RDF), ("crs", CRS), ("papp", PAPP)];

#[derive(Clone, Debug)]
pub struct Attr {
    pub prefix: Option<String>,
    pub local: String,
    pub uri: Option<String>,
    /// The value exactly as written, entity references included.
    pub raw: String,
}

impl Attr {
    /// `crs:` / `papp:` / `rdf:` + local name when the namespace is one of
    /// those (legacy papp included), so ownership is decided by namespace,
    /// never by the prefix a writer happened to choose.
    pub fn canonical(&self) -> Option<String> {
        canonical_name(self.uri.as_deref(), &self.local)
    }
}

#[derive(Clone, Debug)]
pub struct Element {
    pub prefix: Option<String>,
    pub local: String,
    pub uri: Option<String>,
    pub attrs: Vec<Attr>,
    /// Declarations made on this element itself (`None` = default namespace).
    pub declarations: Vec<(Option<String>, String)>,
    pub span: Range<usize>,
    pub start: Range<usize>,
    pub children: Vec<Element>,
    /// Text, CDATA, comments or processing instructions directly inside.
    pub mixed: bool,
}

impl Element {
    pub fn canonical(&self) -> Option<String> {
        canonical_name(self.uri.as_deref(), &self.local)
    }

    pub fn is(&self, name: &str) -> bool {
        self.canonical().as_deref() == Some(name)
    }

    pub fn self_closing(&self) -> bool {
        self.start == self.span
    }

    /// Attributes other than namespace declarations.
    pub fn has_attributes(&self) -> bool {
        !self.attrs.is_empty()
    }
}

pub fn canonical_name(uri: Option<&str>, local: &str) -> Option<String> {
    let prefix = match uri? {
        RDF => "rdf",
        CRS => "crs",
        uri if uri == PAPP || LEGACY_PAPP.contains(&uri) => "papp",
        _ => return None,
    };
    Some(format!("{prefix}:{local}"))
}

fn text(bytes: &[u8]) -> Result<String, String> {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|e| e.to_string())
}

fn resolved(result: ResolveResult) -> Result<Option<String>, String> {
    match result {
        ResolveResult::Bound(namespace) => Ok(Some(text(namespace.into_inner())?)),
        ResolveResult::Unbound => Ok(None),
        ResolveResult::Unknown(prefix) => Err(format!(
            "Undeclared XML prefix {} in a mask",
            String::from_utf8_lossy(&prefix)
        )),
    }
}

fn split(name: QName) -> Result<(Option<String>, String), String> {
    Ok((
        name.prefix().map(|p| text(p.into_inner())).transpose()?,
        text(name.local_name().into_inner())?,
    ))
}

fn element(
    reader: &NsReader<&[u8]>,
    e: &quick_xml::events::BytesStart,
    start: Range<usize>,
) -> Result<Element, String> {
    let (prefix, local) = split(e.name())?;
    let uri = resolved(reader.resolve_element(e.name()).0)?;
    let mut attrs = Vec::new();
    let mut declarations = Vec::new();
    for attr in e.attributes() {
        let attr = attr.map_err(|e| e.to_string())?;
        let raw = text(&attr.value)?;
        match attr.key.as_namespace_binding() {
            Some(quick_xml::name::PrefixDeclaration::Default) => declarations.push((None, raw)),
            Some(quick_xml::name::PrefixDeclaration::Named(p)) => {
                declarations.push((Some(text(p)?), raw))
            }
            None => {
                let (prefix, local) = split(attr.key)?;
                let uri = resolved(reader.resolve_attribute(attr.key).0)?;
                attrs.push(Attr {
                    prefix,
                    local,
                    uri,
                    raw,
                });
            }
        }
    }
    Ok(Element {
        prefix,
        local,
        uri,
        attrs,
        declarations,
        span: start.clone(),
        start,
        children: Vec::new(),
        mixed: false,
    })
}

/// Top-level elements of `xml` (a sequence of self-contained elements).
pub fn parse(xml: &str) -> Result<Vec<Element>, String> {
    let mut reader = NsReader::from_str(xml);
    reader.config_mut().check_end_names = true;
    let mut stack: Vec<Element> = Vec::new();
    let mut roots = Vec::new();
    loop {
        let before = reader.buffer_position() as usize;
        let event = reader.read_event().map_err(|e| e.to_string())?;
        let after = reader.buffer_position() as usize;
        match event {
            Event::Start(e) => stack.push(element(&reader, &e, before..after)?),
            Event::Empty(e) => {
                let leaf = element(&reader, &e, before..after)?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(leaf),
                    None => roots.push(leaf),
                }
            }
            Event::End(_) => {
                let mut done = stack.pop().ok_or("Unbalanced mask XML")?;
                done.span = done.start.start..after;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(done),
                    None => roots.push(done),
                }
            }
            Event::Text(t) => {
                if !t.iter().all(u8::is_ascii_whitespace) {
                    match stack.last_mut() {
                        Some(parent) => parent.mixed = true,
                        None => return Err("Text outside the mask containers".into()),
                    }
                }
            }
            Event::CData(_) | Event::Comment(_) | Event::PI(_) => match stack.last_mut() {
                Some(parent) => parent.mixed = true,
                None => return Err("Markup outside the mask containers".into()),
            },
            Event::Decl(_) | Event::DocType(_) => {
                return Err("Unexpected declaration in mask XML".into())
            }
            Event::Eof => break,
        }
    }
    if !stack.is_empty() {
        return Err("Unclosed mask XML".into());
    }
    Ok(roots)
}

/// Namespace bindings in scope where each element sits, keyed by the
/// element's start offset, so a fragment cut out of the tree can declare
/// exactly the bindings it used to inherit.
pub type Scopes = BTreeMap<usize, BTreeMap<Option<String>, String>>;

pub fn scopes(elements: &[Element]) -> Scopes {
    fn walk(element: &Element, inherited: &BTreeMap<Option<String>, String>, out: &mut Scopes) {
        let mut scope = inherited.clone();
        for (prefix, uri) in &element.declarations {
            scope.insert(prefix.clone(), uri.clone());
        }
        for child in &element.children {
            walk(child, &scope, out);
        }
        out.insert(element.start.start, scope);
    }
    let mut out = Scopes::new();
    for element in elements {
        walk(element, &BTreeMap::new(), &mut out);
    }
    out
}

/// The bindings `element` uses but does not declare itself, as they resolve
/// where it sits in the source.
pub fn used_bindings(element: &Element, scopes: &Scopes) -> BTreeMap<Option<String>, String> {
    fn used(
        element: &Element,
        declared: &mut Vec<Option<String>>,
        out: &mut BTreeMap<Option<String>, ()>,
    ) {
        let mark = declared.len();
        declared.extend(element.declarations.iter().map(|(p, _)| p.clone()));
        let mut note = |prefix: Option<String>| {
            if !declared.contains(&prefix) && prefix.as_deref() != Some("xml") {
                out.insert(prefix, ());
            }
        };
        if element.uri.is_some() || element.prefix.is_some() {
            note(element.prefix.clone());
        }
        for attr in &element.attrs {
            if attr.prefix.is_some() {
                note(attr.prefix.clone());
            }
        }
        for child in &element.children {
            used(child, declared, out);
        }
        declared.truncate(mark);
    }
    let mut needed = BTreeMap::new();
    used(element, &mut Vec::new(), &mut needed);
    let inherited = &scopes[&element.start.start];
    needed
        .keys()
        .filter_map(|prefix| Some((prefix.clone(), inherited.get(prefix)?.clone())))
        .filter(|(_, uri)| uri != XML)
        .collect()
}

/// The `xmlns` declarations `element` needs to mean the same thing when cut
/// out of its ancestors and placed where `context` is in scope.
pub fn detached_declarations(
    element: &Element,
    scopes: &Scopes,
    context: &BTreeMap<Option<String>, String>,
) -> String {
    used_bindings(element, scopes)
        .into_iter()
        .filter(|(prefix, uri)| context.get(prefix) != Some(uri))
        .map(|(prefix, uri)| declaration(prefix.as_deref(), &uri))
        .collect()
}

pub fn declaration(prefix: Option<&str>, uri: &str) -> String {
    match prefix {
        Some(prefix) => format!(" xmlns:{prefix}=\"{}\"", escape_attr(uri)),
        None => format!(" xmlns=\"{}\"", escape_attr(uri)),
    }
}

#[cfg(test)]
pub fn canonical_context() -> BTreeMap<Option<String>, String> {
    CANONICAL
        .iter()
        .map(|(prefix, uri)| (Some((*prefix).to_owned()), (*uri).to_owned()))
        .collect()
}

/// The offset just past `element`'s qualified name in its start tag.
pub fn name_end(source: &str, element: &Element) -> usize {
    element.start.start
        + 1
        + source[element.start.start + 1..element.start.end]
            .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .unwrap_or(0)
}

/// `source[element.span]` with `declarations` inserted into its start tag.
pub fn detached(source: &str, element: &Element, declarations: &str) -> String {
    let name_end = name_end(source, element);
    format!(
        "{}{declarations}{}",
        &source[element.span.start..name_end],
        &source[name_end..element.span.end]
    )
}

pub fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;")
}

/// The whitespace run that ends at `index`, back to the previous line break
/// or non-whitespace character.
pub fn line_indent(source: &str, index: usize) -> &str {
    let head = &source[..index];
    let start = head
        .rfind(|c: char| !(c == ' ' || c == '\t'))
        .map_or(0, |i| {
            i + head[i..].chars().next().map_or(1, char::len_utf8)
        });
    &head[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_scopes_and_detached_declarations_follow_the_source() {
        let xml = r#"<crs:A xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:f="urn:f" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:li f:Tag="1"><f:Child xml:lang="en">t</f:Child></rdf:li><rdf:li/></crs:A>"#;
        let roots = parse(xml).unwrap();
        let root = &roots[0];
        assert!(root.is("crs:A"));
        assert_eq!(&xml[root.span.clone()], xml);
        let li = &root.children[0];
        assert_eq!(li.attrs[0].uri.as_deref(), Some("urn:f"));
        assert!(li.children[0].mixed);
        assert!(root.children[1].self_closing());
        let scopes = scopes(&roots);
        let declarations = detached_declarations(li, &scopes, &canonical_context());
        assert_eq!(declarations, " xmlns:f=\"urn:f\"");
        assert_eq!(
            detached(xml, li, &declarations),
            r#"<rdf:li xmlns:f="urn:f" f:Tag="1"><f:Child xml:lang="en">t</f:Child></rdf:li>"#
        );
    }

    #[test]
    fn a_canonical_prefix_bound_elsewhere_is_redeclared() {
        let xml = r#"<x:A xmlns:x="urn:x" xmlns:crs="urn:not-adobe"><crs:B/></x:A>"#;
        let roots = parse(xml).unwrap();
        let scopes = scopes(&roots);
        let b = &roots[0].children[0];
        assert_eq!(
            detached_declarations(b, &scopes, &canonical_context()),
            " xmlns:crs=\"urn:not-adobe\""
        );
        assert!(parse("<a:B/>").is_err());
        assert_eq!(line_indent("  <a>\n    <b/>", 10), "    ");
    }
}

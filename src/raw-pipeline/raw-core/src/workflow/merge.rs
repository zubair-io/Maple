//! Property-level three-way merge of the primary `rdf:Description` (#4983).
//!
//! A sidecar is a set of properties: each attribute and each top-level child
//! element of the primary Description. The merge never rebuilds the document.
//! It edits the byte spans of the properties that actually change in `head`,
//! so every unknown attribute, unknown child element and every byte outside
//! the Description stays exactly as the current document holds it.
use super::description::{leading_whitespace, table, Description, Property};
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use std::ops::Range;

/// Whether two checkpoints hold the same property values. Attribute order and
/// layout are ignored; a child element's own text is compared exactly. `None`
/// is a document with no properties.
pub(super) fn same_properties(a: Option<&str>, b: &str) -> Result<bool, String> {
    let b = Description::parse(b)?;
    let Some(a) = a else {
        return Ok(b.attributes.is_empty() && b.children.is_empty());
    };
    let a = Description::parse(a)?;
    Ok(table(&a.attributes) == table(&b.attributes) && table(&a.children) == table(&b.children))
}

/// The incoming writer's change is applied on top of `head`: a property the
/// incoming document left as it was in `base` keeps `head`'s value, and any
/// other takes the incoming value (including when both sides changed it).
fn resolve<'v>(
    base: Option<&str>,
    head: Option<&'v str>,
    incoming: Option<&'v str>,
) -> Option<&'v str> {
    if incoming == base {
        head
    } else {
        incoming
    }
}

fn find<'p>(properties: &'p [Property], key: &str) -> Option<&'p Property> {
    properties.iter().find(|p| p.key == key)
}

fn value<'p>(properties: &'p [Property], key: &str) -> Option<&'p str> {
    find(properties, key).map(|p| p.value.as_str())
}

struct Edit {
    start: usize,
    end: usize,
    text: String,
    order: usize,
}

#[derive(Default)]
struct Edits(Vec<Edit>);

impl Edits {
    fn replace(&mut self, range: Range<usize>, text: String) {
        let order = self.0.len();
        self.0.push(Edit {
            start: range.start,
            end: range.end,
            text,
            order,
        });
    }
    fn insert(&mut self, at: usize, text: String) {
        self.replace(at..at, text);
    }
    /// Apply back to front. At one offset a replacement or removal goes first
    /// so an insertion there is never displaced by it, and insertions keep
    /// the order they were queued in.
    fn apply(mut self, xml: &str) -> String {
        self.0.sort_by(|a, b| {
            b.start
                .cmp(&a.start)
                .then((a.start == a.end).cmp(&(b.start == b.end)))
                .then(b.order.cmp(&a.order))
        });
        let mut out = xml.to_owned();
        for edit in self.0 {
            out.replace_range(edit.start..edit.end, &edit.text);
        }
        out
    }
}

/// Merge `incoming` onto `head` using `base` as the common ancestor. `None`
/// base is a document with no properties. All three are checkpoints.
pub(super) fn three_way(base: Option<&str>, head: &str, incoming: &str) -> Result<String, String> {
    let base = base.map(Description::parse).transpose()?;
    let head = Description::parse(head)?;
    let incoming = Description::parse(incoming)?;
    let mut edits = Edits::default();
    let (base_attributes, base_children) = base
        .as_ref()
        .map_or((&[][..], &[][..]), |d| (&d.attributes[..], &d.children[..]));
    merge_attributes(base_attributes, &head, &incoming, &mut edits);
    merge_children(base_children, &head, &incoming, &mut edits);
    let merged = edits.apply(head.xml);
    super::validation::checkpoint(&merged)?;
    namespaces_bound(&merged)?;
    Ok(merged)
}

/// Edits for properties `head` holds: removal when the merged value is gone,
/// replacement when the incoming value wins.
fn merge_existing(
    base: &[Property],
    head: &[Property],
    incoming_xml: &str,
    incoming: &[Property],
    edits: &mut Edits,
) {
    for property in head {
        let theirs = find(incoming, &property.key);
        match resolve(
            value(base, &property.key),
            Some(property.value.as_str()),
            theirs.map(|p| p.value.as_str()),
        ) {
            None => edits.replace(property.lead.start..property.span.end, String::new()),
            Some(merged) if merged != property.value => {
                if let Some(theirs) = theirs {
                    edits.replace(
                        property.span.clone(),
                        incoming_xml[theirs.span.clone()].into(),
                    );
                }
            }
            Some(_) => {}
        }
    }
}

/// Properties only the incoming document holds, in its order, each placed
/// after the nearest preceding property the merged tag holds. `fallback` is
/// the offset for one with no such predecessor.
fn new_properties<'p>(
    base: &[Property],
    head: &[Property],
    incoming: &'p [Property],
    fallback: usize,
) -> Vec<(usize, &'p Property)> {
    let mut anchor = fallback;
    let mut out = Vec::new();
    for property in incoming {
        if let Some(existing) = find(head, &property.key) {
            anchor = existing.span.end;
        } else if resolve(
            value(base, &property.key),
            None,
            Some(property.value.as_str()),
        )
        .is_some()
        {
            out.push((anchor, property));
        }
    }
    out
}

fn merge_attributes(
    base: &[Property],
    head: &Description<'_>,
    incoming: &Description<'_>,
    edits: &mut Edits,
) {
    merge_existing(
        base,
        &head.attributes,
        incoming.xml,
        &incoming.attributes,
        edits,
    );
    let fallback = head
        .attributes
        .first()
        .map_or(head.after_tag_name(), |first| first.lead.start);
    for (at, property) in new_properties(base, &head.attributes, &incoming.attributes, fallback) {
        edits.insert(
            at,
            format!(
                "{}{}",
                &incoming.xml[property.lead.clone()],
                &incoming.xml[property.span.clone()]
            ),
        );
    }
}

fn merge_children(
    base: &[Property],
    head: &Description<'_>,
    incoming: &Description<'_>,
    edits: &mut Edits,
) {
    merge_existing(
        base,
        &head.children,
        incoming.xml,
        &incoming.children,
        edits,
    );
    let fallback = head
        .children
        .first()
        .map(|first| first.lead.start)
        .or_else(|| {
            head.close
                .as_ref()
                .map(|close| leading_whitespace(head.xml, close.start).start)
        })
        .unwrap_or(head.open.end);
    let added = new_properties(base, &head.children, &incoming.children, fallback);
    if head.self_closing && !added.is_empty() {
        // The tag has no body yet: expand it as workflow embedding does.
        let closing = incoming
            .close
            .as_ref()
            .map(|close| &incoming.xml[leading_whitespace(incoming.xml, close.start)])
            .unwrap_or("\n    ");
        let body: String = added
            .iter()
            .map(|(_, property)| {
                format!(
                    "{}{}",
                    &incoming.xml[property.lead.clone()],
                    &incoming.xml[property.span.clone()]
                )
            })
            .collect();
        edits.replace(
            head.open.end - 2..head.open.end,
            format!(">{body}{closing}</rdf:Description>"),
        );
        return;
    }
    for (at, property) in added {
        edits.insert(
            at,
            format!(
                "{}{}",
                &incoming.xml[property.lead.clone()],
                &incoming.xml[property.span.clone()]
            ),
        );
    }
}

/// Every prefixed element and attribute of the merged document must resolve:
/// a combined edit must not strand a name from its namespace declaration.
fn namespaces_bound(xml: &str) -> Result<(), String> {
    let mut reader = NsReader::from_str(xml);
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) | Event::Empty(e) => {
                if matches!(
                    reader.resolve_element(e.name()).0,
                    ResolveResult::Unknown(_)
                ) {
                    return Err("merged element lost its namespace declaration".into());
                }
                for attribute in e.attributes().with_checks(false) {
                    let key = attribute.map_err(|e| e.to_string())?.key;
                    let declaration = key
                        .prefix()
                        .is_some_and(|p| matches!(p.as_ref(), b"xmlns" | b"xml"));
                    if !declaration
                        && matches!(reader.resolve_attribute(key).0, ResolveResult::Unknown(_))
                    {
                        return Err("merged attribute lost its namespace declaration".into());
                    }
                }
            }
            Event::Eof => return Ok(()),
            _ => {}
        }
    }
}

//! Writes Android's edited repair spots back into the containers
//! `retouch_document` read. Every unedited entry keeps its bytes. An edited
//! or new spot is raw-core's canonical entry (`serialize_retouch_areas`)
//! carrying the unknown attributes and child nodes of the description and
//! mask leaf it was read from, and Lightroom's own `crs:Seed`,
//! `crs:MaskValue`, `crs:Flow` and `crs:CenterWeight` values. New spots apply
//! after every spot that was read. Output: `{"containers": [replacement per
//! input container, "" to remove it], "appended": [new containers], "spots":
//! whether the written containers still render a spot}`. A sensor-framed list
//! (`retouch_document::SensorFrame`) is written upright, and the legacy
//! `crs:RetouchInfo` fallback is retired (`retouch_legacy`).
use crate::mask_document::{parse_piece, Bindings};
use crate::mask_xml::{self, Attr, Element, CRS, RDF};
use crate::retouch_document::{spot_from_json, Container, Document, AREAS};
use crate::retouch_legacy::retired;
use crate::xml_carry::{attribute_lines, node_lines, unknown, with_prefixes};
use raw_core::types::{AdjustmentModel, RetouchSpot};
use serde_json::{json, Value};

/// The prefixes canonical repair entries are written under. Never `papp`: a
/// `papp:` declaration would make raw-core read an unstamped Lightroom list
/// as the legacy sensor frame.
const PREFIXES: [(&str, &str); 2] = [("rdf", RDF), ("crs", CRS)];

/// What raw-core reads from a spot's description, plus the constants the
/// canonical writer emits there.
const SPOT_KEYS: [&str; 10] = [
    "crs:SpotType",
    "crs:SourceState",
    "crs:Method",
    "crs:SourceX",
    "crs:SourceY",
    "crs:OffsetX",
    "crs:OffsetY",
    "crs:Opacity",
    "crs:Feather",
    "crs:Seed",
];

/// What raw-core reads from the circular mask leaf, plus the constants the
/// canonical writer emits there.
const LEAF_KEYS: [&str; 8] = [
    "crs:What",
    "crs:MaskValue",
    "crs:X",
    "crs:Y",
    "crs:Radius",
    "crs:Flow",
    "crs:CenterWeight",
    "crs:Feather",
];

/// Constants of the canonical form that render nothing in Maple; a spot read
/// from another writer keeps its own value.
const KEPT_SPOT: [(&str, &str); 1] = [("crs:Seed", "0")];
const KEPT_LEAF: [(&str, &str); 3] = [
    ("crs:MaskValue", "1"),
    ("crs:Flow", "1"),
    ("crs:CenterWeight", "0"),
];

/// `key="canonical"` in `item` replaced by the source attribute's own value.
fn keep_value(item: &mut String, attrs: &[Attr], key: &str, canonical: &str) {
    let Some(attr) = attrs.iter().find(|a| a.canonical().as_deref() == Some(key)) else {
        return;
    };
    let quote = if attr.raw.contains('"') { '\'' } else { '"' };
    let written = format!("{key}=\"{canonical}\"");
    if let Some(at) = item.find(&written) {
        item.replace_range(
            at..at + written.len(),
            &format!("{key}={quote}{}{quote}", attr.raw),
        );
    }
}

/// The spot's source metadata: its description, its circular leaf and the
/// container it was read from.
struct Origin<'a> {
    container: &'a Container,
    description: &'a Element,
    leaf: &'a Element,
}

/// raw-core's canonical entry for `spot`, its first line unindented and every
/// other line under `indent`, carrying `origin`'s metadata.
fn render(
    spot: &RetouchSpot,
    indent: &str,
    origin: Option<Origin>,
    context: &Bindings,
) -> Result<String, String> {
    let model = AdjustmentModel {
        retouch_spots: vec![*spot],
        ..Default::default()
    };
    let block = raw_core::xmp::serialize_retouch_areas(&model, "");
    let unexpected = || "Unexpected repair spot form".to_owned();
    let open = block.find("    <rdf:li>\n").ok_or_else(unexpected)?;
    let close = block.rfind("    </rdf:li>").ok_or_else(unexpected)? + "    </rdf:li>".len();
    let mut item = block[open..close]
        .split('\n')
        .map(|line| line.strip_prefix("    ").unwrap_or(line))
        .collect::<Vec<_>>()
        .join(&format!("\n{indent}"));
    let Some(origin) = origin else {
        return Ok(item);
    };
    for (key, canonical) in KEPT_SPOT {
        keep_value(&mut item, &origin.description.attrs, key, canonical);
    }
    for (key, canonical) in KEPT_LEAF {
        keep_value(&mut item, &origin.leaf.attrs, key, canonical);
    }
    let (text, scopes) = (&origin.container.text, &origin.container.scopes);
    let attrs = format!("{indent}    ");
    let leaf_indent = format!("{indent}        ");
    let leaf_end = item.find("/>").ok_or_else(unexpected)?;
    let extra = attribute_lines(
        &unknown(&origin.leaf.attrs, &LEAF_KEYS),
        context,
        &format!("{leaf_indent}  "),
    );
    let children: Vec<&Element> = origin.leaf.children.iter().collect();
    let closing = if children.is_empty() {
        "/>".to_owned()
    } else {
        let lines = node_lines(
            text,
            scopes,
            &children,
            context,
            &format!("{leaf_indent}  "),
        );
        format!(">\n{lines}{leaf_indent}</rdf:li>")
    };
    item.replace_range(leaf_end..leaf_end + 2, &format!("{extra}{closing}"));
    let masks_close = format!("{attrs}</crs:Masks>\n");
    let after_masks = item.find(&masks_close).ok_or_else(unexpected)? + masks_close.len();
    let nodes: Vec<&Element> = origin
        .description
        .children
        .iter()
        .filter(|child| !child.is("crs:Masks"))
        .collect();
    item.insert_str(
        after_masks,
        &node_lines(text, scopes, &nodes, context, &attrs),
    );
    let masks_at = item
        .find(&format!(">\n{attrs}<crs:Masks>"))
        .ok_or_else(unexpected)?;
    item.insert_str(
        masks_at,
        &attribute_lines(
            &unknown(&origin.description.attrs, &SPOT_KEYS),
            context,
            &attrs,
        ),
    );
    Ok(item)
}

enum Fate {
    Keep,
    Replace(RetouchSpot),
    Remove,
}

struct Plan<'a> {
    document: &'a Document,
    spots: Vec<(RetouchSpot, Option<usize>)>,
    /// The structured container new spots are appended to, if one exists.
    append_into: Option<usize>,
}

impl Plan<'_> {
    fn new_spots(&self) -> Vec<RetouchSpot> {
        self.spots
            .iter()
            .filter(|(_, slot)| slot.is_none())
            .map(|(spot, _)| *spot)
            .collect()
    }

    fn fate(&self, slot: Option<usize>) -> Fate {
        let Some((entry, _, _)) = slot.and_then(|slot| self.document.authored(slot)) else {
            return Fate::Keep;
        };
        match self.spots.iter().find(|(_, s)| *s == slot) {
            None => Fate::Remove,
            // A sensor-framed entry is rewritten upright even when unchanged: the
            // written list is stamped upright.
            Some((spot, _)) if self.document.frame.is_none() && Some(*spot) == entry.spot => {
                Fate::Keep
            }
            Some((spot, _)) => Fate::Replace(*spot),
        }
    }

    fn item_indent(container: &Container, seq: &Element) -> String {
        match seq.children.first() {
            Some(first) => mask_xml::line_indent(&container.text, first.span.start).to_owned(),
            None => {
                let close = container.text[..seq.span.end]
                    .rfind("</")
                    .unwrap_or(seq.span.end);
                format!("{}  ", mask_xml::line_indent(&container.text, close))
            }
        }
    }

    fn container(&self, index: usize) -> Result<String, String> {
        let document = self.document;
        let container = &document.containers[index];
        let verbatim = container.text[container.root.span.clone()].to_owned();
        let Some(seq) = &container.seq else {
            return Ok(verbatim);
        };
        let slot_of = |item: usize| {
            document
                .entries
                .iter()
                .position(|e| e.container == index && e.item == item)
        };
        let fates: Vec<Fate> = (0..seq.children.len())
            .map(|item| self.fate(slot_of(item)))
            .collect();
        let appended = if self.append_into == Some(index) {
            self.new_spots()
        } else {
            Vec::new()
        };
        let replaced = fates.iter().any(|f| matches!(f, Fate::Replace(_)));
        if !replaced && appended.is_empty() && !fates.iter().any(|f| matches!(f, Fate::Remove)) {
            return Ok(verbatim);
        }
        let inside = container.scopes[&seq.start.start].clone();
        let (context, additions) = if replaced || !appended.is_empty() {
            with_prefixes(&inside, &PREFIXES)
        } else {
            (inside, String::new())
        };
        let indent = Self::item_indent(container, seq);
        let text = &container.text;
        let name_end = mask_xml::name_end(text, &container.root);
        let mut out = format!(
            "{}{additions}{}",
            &text[container.root.span.start..name_end],
            &text[name_end..seq.start.end]
        );
        let mut cursor = seq.start.end;
        let mut entries = 0;
        for (item_index, (item, fate)) in seq.children.iter().zip(fates).enumerate() {
            match fate {
                Fate::Keep => {
                    let declarations =
                        mask_xml::detached_declarations(item, &container.scopes, &context);
                    out.push_str(&text[cursor..item.span.start]);
                    out.push_str(&mask_xml::detached(text, item, &declarations));
                    entries += 1;
                }
                Fate::Replace(spot) => {
                    let (_, description, leaf) = slot_of(item_index)
                        .and_then(|slot| document.authored(slot))
                        .ok_or("Repair spot lost its source entry")?;
                    let origin = Origin {
                        container,
                        description,
                        leaf,
                    };
                    out.push_str(&text[cursor..item.span.start]);
                    out.push_str(&render(&spot, &indent, Some(origin), &context)?);
                    entries += 1;
                }
                Fate::Remove => {
                    let end = text[cursor..item.span.start].trim_end().len() + cursor;
                    out.push_str(&text[cursor..end]);
                }
            }
            cursor = item.span.end;
        }
        for spot in &appended {
            out.push_str(&format!(
                "\n{indent}{}",
                render(spot, &indent, None, &context)?
            ));
            entries += 1;
        }
        out.push_str(&text[cursor..container.root.span.end]);
        Ok(if entries == 0 { String::new() } else { out })
    }

    /// A new structured container for the new spots when the sidecar has none
    /// to append to, starting at its tag; later lines sit under `indent`.
    fn appended(&self, indent: &str) -> Vec<String> {
        let spots = self.new_spots();
        if self.append_into.is_some() || spots.is_empty() {
            return Vec::new();
        }
        let (_, additions) = with_prefixes(&self.document.target, &PREFIXES);
        let model = AdjustmentModel {
            retouch_spots: spots,
            ..Default::default()
        };
        let block = raw_core::xmp::serialize_retouch_areas(&model, indent);
        let block = block.strip_prefix(indent).unwrap_or(&block);
        vec![block.replacen(&format!("<{AREAS}>"), &format!("<{AREAS}{additions}>"), 1)]
    }
}

fn validate(document: &Document, spots: &[(RetouchSpot, Option<usize>)]) -> Result<(), String> {
    let mut last = None;
    let mut new_seen = false;
    for (_, slot) in spots {
        let Some(slot) = *slot else {
            new_seen = true;
            continue;
        };
        if new_seen {
            return Err("New repair spots follow the spots that were read".into());
        }
        if !document.any_areas || document.authored(slot).is_none() {
            return Err("Repair spot names an entry Android does not author".into());
        }
        if last.is_some_and(|last| last >= slot) {
            return Err("Repair spots must keep their read order".into());
        }
        last = Some(slot);
    }
    Ok(())
}

/// Refuses an edit that would stamp a sensor-framed list upright while it
/// still holds spots raw-core renders that Android cannot rewrite upright.
fn convertible(document: &Document) -> Result<(), String> {
    let kept = document
        .entries
        .iter()
        .any(|entry| entry.spot.is_some() && entry.authored.is_none());
    if document.frame.is_some() && (kept || document.opaque_areas) {
        return Err("These repair spots predate the upright frame and include spots Android cannot convert; edit them in Maple on a Mac or iPad".into());
    }
    Ok(())
}

pub fn write(input: &Value) -> Result<Value, String> {
    let document = Document::read(input)?;
    let indent = input.get("indent").and_then(Value::as_str).unwrap_or("");
    let spots = input
        .get("spots")
        .and_then(Value::as_array)
        .ok_or("No repair spots to write")?
        .iter()
        .map(spot_from_json)
        .collect::<Result<Vec<_>, _>>()?;
    validate(&document, &spots)?;
    convertible(&document)?;
    let plan = Plan {
        append_into: document.containers.iter().rposition(|c| c.seq.is_some()),
        document: &document,
        spots,
    };
    let mut containers = (0..document.containers.len())
        .map(|index| plan.container(index))
        .collect::<Result<Vec<_>, _>>()?;
    let appended = plan.appended(indent);
    // Authoring the structured list retires the legacy fallback raw-core would
    // otherwise read again once no structured spot is left.
    let edited = !appended.is_empty()
        || containers
            .iter()
            .zip(&document.containers)
            .any(|(out, c)| *out != c.text[c.root.span.clone()]);
    if !document.any_areas || edited {
        for index in &document.legacy_containers {
            containers[*index] = retired(&document.containers[*index])?;
        }
    }
    let mut spots = false;
    for (out, container) in containers.iter().zip(&document.containers) {
        spots |= !out.is_empty() && !parse_piece(out, &container.scope)?.retouch_spots.is_empty();
    }
    spots |= !plan.new_spots().is_empty();
    Ok(json!({"containers": containers, "appended": appended, "spots": spots}))
}

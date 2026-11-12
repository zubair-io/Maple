//! Writes Android's edited layers back into the mask containers it read.
//! A layer still equal to its source correction keeps that correction's
//! bytes; an edited or new layer is raw-core's canonical correction
//! (`serialize_local_adjustments`) carrying the unknown attributes and child
//! nodes of the correction and mask leaves it came from. Corrections Android
//! does not author stay verbatim in place, and `papp:LayerOrder` keys follow
//! `mask_order`. Output: `{"containers": [replacement per input container,
//! "" to remove it], "appended": new containers for the last description}`.
use crate::mask_document::{Bindings, Container, Document, CONTAINERS};
use crate::mask_model::{layer_from_json, AuthoredLayer};
use crate::mask_order::{assign, container_rank, format_key};
use crate::mask_xml::{self, canonical_context, Attr, Element};
use raw_core::types::{AdjustmentModel, Mask};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// What raw-core reads from a correction description; anything else is
/// metadata that travels with the correction.
const CORRECTION_KEYS: [&str; 31] = [
    "crs:What",
    "crs:CorrectionActive",
    "crs:CorrectionAmount",
    "papp:LayerOrder",
    "crs:LocalExposure2012",
    "crs:LocalContrast2012",
    "crs:LocalHighlights2012",
    "crs:LocalShadows2012",
    "crs:LocalWhites2012",
    "crs:LocalBlacks2012",
    "crs:LocalSaturation",
    "papp:LocalVibrance",
    "crs:LocalTemperature",
    "crs:LocalTint",
    "crs:LocalHue",
    "crs:LocalTexture",
    "crs:LocalClarity2012",
    "crs:LocalDehaze",
    "crs:LocalSharpness",
    "crs:LocalLuminanceNoise",
    "crs:LocalDefringe",
    "papp:RangeKind",
    "papp:RangeHue",
    "papp:RangeHueWidth",
    "papp:RangeChromaMin",
    "papp:RangeLMin",
    "papp:RangeLMax",
    "papp:RangeFeather",
    "papp:MaskGroupVersion",
    "papp:MaskGroupOpacity",
    "papp:MaskGroupInverted",
];

/// What raw-core reads from a mask leaf.
const COMPONENT_KEYS: [&str; 28] = [
    "crs:What",
    "crs:MaskValue",
    "crs:MaskActive",
    "crs:MaskBlendMode",
    "crs:MaskInverted",
    "papp:MaskCombine",
    "papp:LocalFeather",
    "crs:ZeroX",
    "crs:ZeroY",
    "crs:FullX",
    "crs:FullY",
    "crs:Top",
    "crs:Left",
    "crs:Bottom",
    "crs:Right",
    "crs:Angle",
    "crs:Midpoint",
    "crs:Roundness",
    "crs:Feather",
    "crs:Flipped",
    "crs:Version",
    "crs:MaskSubType",
    "papp:MaskSource",
    "papp:MaskPerson",
    "papp:MaskFacialSkin",
    "papp:MaskBodySkin",
    "papp:MaskModel",
    "papp:MaskDigest",
];

fn unknown<'a>(attrs: &'a [Attr], owned: &[&str]) -> Vec<&'a Attr> {
    attrs
        .iter()
        .filter(|attr| {
            attr.canonical()
                .is_none_or(|name| !owned.contains(&name.as_str()))
        })
        .collect()
}

/// Attribute lines for `attrs` at `indent`, under `context`; namespaces the
/// context does not bind are declared on the same tag, renamed when a
/// canonical prefix is already taken there.
fn attribute_lines(attrs: &[&Attr], context: &Bindings, indent: &str) -> String {
    let mut declared: BTreeMap<String, String> = BTreeMap::new();
    let mut lines = String::new();
    let mut declarations = String::new();
    for attr in attrs {
        let name = match (&attr.prefix, &attr.uri) {
            (Some(prefix), Some(uri)) if context.get(&Some(prefix.clone())) == Some(uri) => {
                format!("{prefix}:{}", attr.local)
            }
            (Some(prefix), Some(uri)) => {
                let reserved = mask_xml::CANONICAL.iter().any(|(p, _)| p == prefix);
                let chosen = if let Some((p, _)) = declared.iter().find(|(_, u)| *u == uri) {
                    p.clone()
                } else if !reserved && !declared.contains_key(prefix) {
                    prefix.clone()
                } else {
                    (1..)
                        .map(|n| format!("ns{n}"))
                        .find(|p| {
                            !declared.contains_key(p) && !context.contains_key(&Some(p.clone()))
                        })
                        .unwrap_or_default()
                };
                if declared.insert(chosen.clone(), uri.clone()).is_none() {
                    declarations.push_str(&format!(
                        "\n{indent}xmlns:{chosen}=\"{}\"",
                        mask_xml::escape_attr(uri)
                    ));
                }
                format!("{chosen}:{}", attr.local)
            }
            _ => attr.local.clone(),
        };
        let quote = if attr.raw.contains('"') { '\'' } else { '"' };
        lines.push_str(&format!("\n{indent}{name}={quote}{}{quote}", attr.raw));
    }
    declarations + &lines
}

fn node_lines(
    container: &Container,
    nodes: &[&Element],
    context: &Bindings,
    indent: &str,
) -> String {
    nodes
        .iter()
        .map(|node| {
            let declarations = mask_xml::detached_declarations(node, &container.scopes, context);
            format!(
                "{indent}{}\n",
                mask_xml::detached(&container.text, node, &declarations)
            )
        })
        .collect()
}

/// The source a re-rendered layer takes its metadata from.
struct Origin<'a> {
    container: &'a Container,
    description: &'a Element,
    leaves: &'a [Element],
}

/// raw-core's canonical correction for `layer`, its first line unindented
/// and every other line under `indent`.
fn render(
    layer: &AuthoredLayer,
    key: Option<f64>,
    indent: &str,
    origin: Option<Origin>,
    context: &Bindings,
) -> Result<String, String> {
    let model = AdjustmentModel {
        local_adjustments: vec![layer.layer.clone()],
        ..Default::default()
    };
    let block = raw_core::xmp::serialize_local_adjustments(&model, "");
    let open = block
        .find("    <rdf:li>\n")
        .ok_or("Unexpected correction form")?;
    let close = block
        .rfind("    </rdf:li>")
        .ok_or("Unexpected correction form")?
        + "    </rdf:li>".len();
    let mut item = block[open..close]
        .split('\n')
        .map(|line| line.strip_prefix("    ").unwrap_or(line))
        .collect::<Vec<_>>()
        .join(&format!("\n{indent}"));
    let attrs = format!("{indent}    ");
    if let Some(key) = key {
        let active = "crs:CorrectionActive=\"True\"";
        let at = item.find(active).ok_or("Unexpected correction form")? + active.len();
        item.insert_str(
            at,
            &format!("\n{attrs}papp:LayerOrder=\"{}\"", format_key(key)),
        );
    }
    let Some(origin) = origin else {
        return Ok(item);
    };
    let masks = format!(">\n{attrs}<crs:CorrectionMasks>");
    let masks_at = item.find(&masks).ok_or("Unexpected correction form")?;
    let leaf_indent = format!("{indent}        ");
    let leaf_starts: Vec<usize> = item[masks_at..]
        .match_indices("<rdf:li\n")
        .map(|(at, _)| masks_at + at)
        .collect();
    for (component, start) in leaf_starts.iter().enumerate().rev() {
        let Some(Some(source)) = layer.sources.get(component) else {
            continue;
        };
        let leaf = &origin.leaves[*source];
        let end = start + item[*start..].find("/>").ok_or("Unexpected mask leaf")?;
        let extra = attribute_lines(
            &unknown(&leaf.attrs, &COMPONENT_KEYS),
            context,
            &format!("{leaf_indent}  "),
        );
        let children: Vec<&Element> = leaf.children.iter().collect();
        let closing = if children.is_empty() {
            "/>".to_owned()
        } else {
            format!(
                ">\n{}{leaf_indent}</rdf:li>",
                node_lines(
                    origin.container,
                    &children,
                    context,
                    &format!("{leaf_indent}  ")
                )
            )
        };
        item.replace_range(end..end + 2, &format!("{extra}{closing}"));
    }
    let nodes: Vec<&Element> = origin
        .description
        .children
        .iter()
        .filter(|child| !child.is("crs:CorrectionMasks"))
        .collect();
    let masks_close = format!("{attrs}</crs:CorrectionMasks>\n");
    let after_masks = item
        .find(&masks_close)
        .ok_or("Unexpected correction form")?
        + masks_close.len();
    item.insert_str(
        after_masks,
        &node_lines(origin.container, &nodes, context, &attrs),
    );
    item.insert_str(
        masks_at,
        &attribute_lines(
            &unknown(&origin.description.attrs, &CORRECTION_KEYS),
            context,
            &attrs,
        ),
    );
    Ok(item)
}

fn component_count(mask: &Mask) -> usize {
    match mask {
        Mask::Group(group) => group.components.len(),
        _ => 1,
    }
}

fn validate(document: &Document, layers: &[AuthoredLayer]) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for layer in layers {
        if layer.sources.len() != component_count(&layer.layer.mask) {
            return Err("Mask components and their sources disagree".into());
        }
        let Some(slot) = layer.slot else {
            if layer.sources.iter().any(Option::is_some) {
                return Err("A new mask layer cannot name source leaves".into());
            }
            continue;
        };
        let leaves = document
            .corrections
            .get(slot)
            .and_then(|c| c.authored.as_ref())
            .map(|(_, leaves)| leaves.len())
            .ok_or("Mask layer names a correction Android does not author")?;
        if !seen.insert(slot) {
            return Err("Two mask layers name the same correction".into());
        }
        if layer.sources.iter().flatten().any(|leaf| *leaf >= leaves) {
            return Err("Mask component names a missing source leaf".into());
        }
    }
    Ok(())
}

fn with_canonical(context: &Bindings) -> (Bindings, String) {
    let mut merged = context.clone();
    let mut declarations = String::new();
    for (prefix, uri) in canonical_context() {
        if context.get(&prefix) != Some(&uri) {
            declarations.push_str(&mask_xml::declaration(prefix.as_deref(), &uri));
            merged.insert(prefix, uri);
        }
    }
    (merged, declarations)
}

enum Fate {
    Keep,
    /// Rewritten from the layer at this index.
    Replace(usize),
    Remove,
}

struct Plan<'a> {
    document: &'a Document,
    layers: Vec<AuthoredLayer>,
    keys: Vec<Option<f64>>,
    /// The correction slot each layer is written back over, if any.
    in_place: Vec<Option<usize>>,
    /// The container each displaced or new layer is appended to.
    append_into: [Option<usize>; 4],
}

impl Plan<'_> {
    fn origin(&self, layer: &AuthoredLayer) -> Option<Origin<'_>> {
        let correction = &self.document.corrections[layer.slot?];
        let (description, leaves) = correction.authored.as_ref()?;
        Some(Origin {
            container: &self.document.containers[correction.container],
            description,
            leaves,
        })
    }

    fn item_indent(container: &Container) -> String {
        let seq = container.seq.as_ref().expect("clean container");
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
        let container = &self.document.containers[index];
        let Some(seq) = &container.seq else {
            return Ok(container.text[container.root.span.clone()].to_owned());
        };
        let slots: BTreeMap<usize, usize> = self
            .document
            .corrections
            .iter()
            .enumerate()
            .filter(|(_, c)| c.container == index)
            .map(|(slot, c)| (c.item, slot))
            .collect();
        let appended: Vec<usize> = (0..self.layers.len())
            .filter(|i| {
                self.in_place[*i].is_none()
                    && self.append_into[container_rank(&self.layers[*i].layer.mask)] == Some(index)
            })
            .collect();
        let inside = container.scopes[&seq.start.start].clone();
        let mut fates = Vec::with_capacity(seq.children.len());
        let mut rewritten = !appended.is_empty();
        for item in 0..seq.children.len() {
            let slot = slots[&item];
            let fate = match self.in_place.iter().position(|s| *s == Some(slot)) {
                None if self.document.corrections[slot].authored.is_some() => Fate::Remove,
                None => Fate::Keep,
                Some(layer) if self.reused(layer, slot) => Fate::Keep,
                Some(layer) => {
                    rewritten = true;
                    Fate::Replace(layer)
                }
            };
            fates.push(fate);
        }
        let (context, additions) = if rewritten {
            with_canonical(&inside)
        } else {
            (inside.clone(), String::new())
        };
        let indent = Self::item_indent(container);
        let text = &container.text;
        let name_end = mask_xml::name_end(text, &container.root);
        let mut out = format!(
            "{}{additions}{}",
            &text[container.root.span.start..name_end],
            &text[name_end..seq.start.end]
        );
        let mut cursor = seq.start.end;
        let mut entries = 0;
        for (item, fate) in seq.children.iter().zip(fates) {
            match fate {
                Fate::Keep => {
                    let declarations =
                        mask_xml::detached_declarations(item, &container.scopes, &context);
                    out.push_str(&text[cursor..item.span.start]);
                    out.push_str(&mask_xml::detached(text, item, &declarations));
                    entries += 1;
                }
                Fate::Replace(layer) => {
                    out.push_str(&text[cursor..item.span.start]);
                    let origin = self.origin(&self.layers[layer]);
                    out.push_str(&render(
                        &self.layers[layer],
                        self.keys[layer],
                        &indent,
                        origin,
                        &context,
                    )?);
                    entries += 1;
                }
                Fate::Remove => {
                    let ws = text[cursor..item.span.start].trim_end().len() + cursor;
                    out.push_str(&text[cursor..ws]);
                }
            }
            cursor = item.span.end;
        }
        for layer in &appended {
            let origin = self.origin(&self.layers[*layer]);
            let rendered = render(
                &self.layers[*layer],
                self.keys[*layer],
                &indent,
                origin,
                &context,
            )?;
            out.push_str(&format!("\n{indent}{rendered}"));
            entries += 1;
        }
        out.push_str(&text[cursor..container.root.span.end]);
        Ok(if entries == 0 { String::new() } else { out })
    }

    fn reused(&self, layer: usize, slot: usize) -> bool {
        let correction = &self.document.corrections[slot];
        let leaves = correction.authored.as_ref().map_or(0, |(_, l)| l.len());
        correction.layer.as_ref() == Some(&self.layers[layer].layer)
            && correction.key.map(format_key) == self.keys[layer].map(format_key)
            && self.layers[layer].sources == (0..leaves).map(Some).collect::<Vec<_>>()
    }

    /// New containers, each starting at its tag; later lines sit under `indent`.
    fn appended(&self, indent: &str) -> Result<Vec<String>, String> {
        let (context, additions) = with_canonical(&self.document.target);
        let item_indent = format!("{indent}    ");
        let mut blocks = Vec::new();
        for (rank, name) in CONTAINERS.iter().enumerate() {
            if self.append_into[rank].is_some() {
                continue;
            }
            let members: Vec<usize> = (0..self.layers.len())
                .filter(|i| {
                    self.in_place[*i].is_none()
                        && container_rank(&self.layers[*i].layer.mask) == rank
                })
                .collect();
            if members.is_empty() {
                continue;
            }
            let mut block = format!("<{name}{additions}>\n{indent}  <rdf:Seq>\n");
            for layer in members {
                let origin = self.origin(&self.layers[layer]);
                let rendered = render(
                    &self.layers[layer],
                    self.keys[layer],
                    &item_indent,
                    origin,
                    &context,
                )?;
                block.push_str(&format!("{item_indent}{rendered}\n"));
            }
            block.push_str(&format!("{indent}  </rdf:Seq>\n{indent}</{name}>"));
            blocks.push(block);
        }
        Ok(blocks)
    }
}

pub fn write(input: &Value) -> Result<Value, String> {
    let document = Document::read(input)?;
    let indent = input.get("indent").and_then(Value::as_str).unwrap_or("");
    let layers = input
        .get("layers")
        .and_then(Value::as_array)
        .ok_or("No mask layers to write")?
        .iter()
        .map(layer_from_json)
        .collect::<Result<Vec<_>, _>>()?;
    validate(&document, &layers)?;
    let ranks: Vec<usize> = layers
        .iter()
        .map(|l| container_rank(&l.layer.mask))
        .collect();
    let mut append_into = [None; 4];
    for (rank, slot) in append_into.iter_mut().enumerate() {
        *slot = document
            .containers
            .iter()
            .rposition(|c| c.rank == Some(rank) && c.seq.is_some());
    }
    let in_place: Vec<Option<usize>> = layers
        .iter()
        .zip(&ranks)
        .map(|(layer, rank)| {
            layer.slot.filter(|slot| {
                document.containers[document.corrections[*slot].container].rank == Some(*rank)
            })
        })
        .collect();
    let positions: Vec<(usize, usize, usize)> = (0..layers.len())
        .map(|i| match (in_place[i], append_into[ranks[i]]) {
            (Some(slot), _) => {
                let correction = &document.corrections[slot];
                (correction.container, correction.item, 0)
            }
            (None, Some(container)) => (container, usize::MAX, i),
            (None, None) => (document.containers.len() + ranks[i], 0, i),
        })
        .collect();
    let stamp = positions.windows(2).any(|pair| pair[0] >= pair[1]);
    let read: Vec<Option<f64>> = layers
        .iter()
        .map(|l| l.slot.and_then(|slot| document.corrections[slot].key))
        .collect();
    let keys = assign(stamp, &read, &document.verbatim_keys);
    let plan = Plan {
        document: &document,
        layers,
        keys,
        in_place,
        append_into,
    };
    let containers = (0..document.containers.len())
        .map(|index| plan.container(index))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"containers": containers, "appended": plan.appended(indent)?}))
}

pub fn read(input: &Value) -> Result<Value, String> {
    let layers = Document::read(input)?.layers()?;
    Ok(json!({"layers": layers.iter().map(crate::mask_model::layer_json).collect::<Vec<_>>()}))
}

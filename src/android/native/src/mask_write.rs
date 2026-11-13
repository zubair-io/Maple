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
use crate::mask_stack;
use crate::mask_xml::{self, Element};
use crate::xml_carry::{attribute_lines, node_lines, unknown, with_prefixes};
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
    // Declared on the correction's tag, so in scope for everything under it.
    let (correction_attrs, inner) = attribute_lines(
        &unknown(&origin.description.attrs, &CORRECTION_KEYS),
        context,
        &attrs,
    );
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
        let (extra, leaf_context) = attribute_lines(
            &unknown(&leaf.attrs, &COMPONENT_KEYS),
            &inner,
            &format!("{leaf_indent}  "),
        );
        let children: Vec<&Element> = leaf.children.iter().collect();
        let closing = if children.is_empty() {
            "/>".to_owned()
        } else {
            format!(
                ">\n{}{leaf_indent}</rdf:li>",
                node_lines(
                    &origin.container.text,
                    &origin.container.scopes,
                    &children,
                    &leaf_context,
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
        &node_lines(
            &origin.container.text,
            &origin.container.scopes,
            &nodes,
            &inner,
            &attrs,
        ),
    );
    item.insert_str(masks_at, &correction_attrs);
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

/// `context` with the canonical prefixes bound, and the declarations that adds.
fn with_canonical(context: &Bindings) -> (Bindings, String) {
    with_prefixes(context, &mask_xml::CANONICAL)
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
    /// Keys stamped on corrections kept verbatim, by slot, when the stack is restacked.
    kept_keys: BTreeMap<usize, f64>,
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
        // A canonical binding the container or its sequence declares differently cannot be
        // declared again on that tag: it goes on each rendered correction instead.
        let own = |prefix: &Option<String>| {
            container
                .root
                .declarations
                .iter()
                .chain(&seq.declarations)
                .any(|(declared, _)| declared == prefix)
        };
        let scoped = context
            .iter()
            .any(|(prefix, uri)| inside.get(prefix) != Some(uri) && own(prefix));
        let (tag_additions, item_additions, kept) = if scoped {
            (String::new(), additions, &inside)
        } else {
            (additions, String::new(), &context)
        };
        let rendered = |layer: usize, indent: &str| -> Result<String, String> {
            let item = render(
                &self.layers[layer],
                self.keys[layer],
                indent,
                self.origin(&self.layers[layer]),
                &context,
            )?;
            let open = "<rdf:li".len();
            Ok(format!(
                "{}{item_additions}{}",
                &item[..open],
                &item[open..]
            ))
        };
        let indent = Self::item_indent(container);
        let text = &container.text;
        let name_end = mask_xml::name_end(text, &container.root);
        let mut out = format!(
            "{}{tag_additions}{}",
            &text[container.root.span.start..name_end],
            &text[name_end..seq.start.end]
        );
        let mut cursor = seq.start.end;
        let mut entries = 0;
        for (item_index, (item, fate)) in seq.children.iter().zip(fates).enumerate() {
            match fate {
                Fate::Keep => {
                    let declarations =
                        mask_xml::detached_declarations(item, &container.scopes, kept);
                    out.push_str(&text[cursor..item.span.start]);
                    let slot = slots[&item_index];
                    match self.kept_keys.get(&slot) {
                        Some(key) => out.push_str(&mask_stack::stamped(
                            text,
                            item,
                            &declarations,
                            *key,
                            &container.scopes,
                        )?),
                        None => out.push_str(&mask_xml::detached(text, item, &declarations)),
                    }
                    entries += 1;
                }
                Fate::Replace(layer) => {
                    out.push_str(&text[cursor..item.span.start]);
                    out.push_str(&rendered(layer, &indent)?);
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
            out.push_str(&format!("\n{indent}{}", rendered(*layer, &indent)?));
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
    document.check_legacy_migration()?;
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
    let restack = mask_stack::restack(&document, &layers, &positions)?;
    let (keys, kept_keys) = match restack {
        Some(restack) => (restack.layers, restack.kept),
        None => {
            let stamp = positions.windows(2).any(|pair| pair[0] >= pair[1]);
            let read: Vec<Option<f64>> = layers
                .iter()
                .map(|l| l.slot.and_then(|slot| document.corrections[slot].key))
                .collect();
            (
                assign(stamp, &read, &document.verbatim_keys),
                BTreeMap::new(),
            )
        }
    };
    let plan = Plan {
        document: &document,
        layers,
        keys,
        in_place,
        append_into,
        kept_keys,
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

//! Keeps an edit from moving Android's layers across the corrections it keeps
//! verbatim. raw-core reads the stack in `papp:LayerOrder` order only when every
//! modeled correction is keyed, and in document order otherwise. In a stack
//! read in document order beside a kept correction, the edit is placed in that
//! order. When the written document order would no longer match it (a layer
//! relocated into another container, reordered or added past a kept
//! correction), or when the keys written would key the whole stack (every kept
//! correction is keyed and no Android layer stays unkeyed), every modeled
//! correction is keyed by that order: Android's layers and the kept ones, which
//! keep their place in the stack.
use crate::mask_document::Document;
use crate::mask_model::AuthoredLayer;
use crate::mask_order::{assign, format_key};
use crate::mask_xml::{self, Element, Scopes, PAPP};
use std::collections::BTreeMap;

/// Keys for every modeled correction once the stack has to be keyed.
pub struct Restack {
    /// One key per Android layer, in model order; `None` writes no key.
    pub layers: Vec<Option<f64>>,
    /// Keys stamped on the kept corrections, by correction slot.
    pub kept: BTreeMap<usize, f64>,
}

enum Unit {
    Android(usize),
    Kept(usize),
    /// A modeled correction outside a clean sequence: it cannot be keyed.
    Opaque(usize, usize),
}

/// `None` when the keys the plain assignment writes keep the stack's order;
/// `positions` are each layer's written `(container, item, order)`.
pub fn restack(
    document: &Document,
    layers: &[AuthoredLayer],
    positions: &[(usize, usize, usize)],
) -> Result<Option<Restack>, String> {
    if document.all_keyed {
        return Ok(None);
    }
    let mut units = Vec::new();
    for (index, container) in document.containers.iter().enumerate() {
        units.extend((0..container.opaque).map(|k| Unit::Opaque(index, k)));
        for (slot, correction) in document.corrections.iter().enumerate() {
            if correction.container != index || correction.layer.is_none() {
                continue;
            }
            units.push(match correction.authored {
                Some(_) => Unit::Android(slot),
                None => Unit::Kept(slot),
            });
        }
    }
    // Android's layers alone read in model order, which is the document order here.
    if units.iter().all(|unit| matches!(unit, Unit::Android(_))) {
        return Ok(None);
    }
    // Today's stack is the document order: number it, then place the edit in it.
    let order = |slot: usize| {
        units
            .iter()
            .position(|unit| matches!(unit, Unit::Android(s) if *s == slot))
            .map(|at| at as f64)
    };
    let read: Vec<Option<f64>> = layers
        .iter()
        .map(|layer| layer.slot.and_then(order))
        .collect();
    let fixed: Vec<f64> = units
        .iter()
        .enumerate()
        .filter(|(_, unit)| !matches!(unit, Unit::Android(_)))
        .map(|(at, _)| at as f64)
        .collect();
    let keys: Vec<f64> = assign(false, &read, &fixed).into_iter().flatten().collect();
    let mut written: Vec<((usize, usize, usize), f64)> = positions
        .iter()
        .copied()
        .zip(keys.iter().copied())
        .collect();
    for (at, unit) in units.iter().enumerate() {
        let position = match unit {
            Unit::Android(_) => continue,
            Unit::Kept(slot) => {
                let correction = &document.corrections[*slot];
                (correction.container, correction.item, 0)
            }
            Unit::Opaque(container, k) => (*container, *k, 0),
        };
        written.push((position, at as f64));
    }
    written.sort_by_key(|(position, _)| *position);
    if written.windows(2).all(|pair| pair[0].1 < pair[1].1) {
        // An unkeyed kept correction keeps raw-core on document order.
        if document.verbatim_unkeyed {
            return Ok(None);
        }
        // Every kept correction is keyed: an Android layer left unkeyed does the same,
        // so the read keys stay as they are.
        let read: Vec<Option<f64>> = layers
            .iter()
            .map(|layer| layer.slot.and_then(|slot| document.corrections[slot].key))
            .collect();
        if read.iter().any(Option::is_none) {
            return Ok(Some(Restack {
                layers: read,
                kept: BTreeMap::new(),
            }));
        }
    }
    if units.iter().any(|unit| matches!(unit, Unit::Opaque(..))) {
        return Err("This edit would reorder masks Android cannot rewrite; edit this stack in Maple on a Mac or iPad".into());
    }
    let kept = units
        .iter()
        .enumerate()
        .filter_map(|(at, unit)| match unit {
            Unit::Kept(slot) => Some((*slot, at as f64)),
            _ => None,
        })
        .collect();
    Ok(Some(Restack {
        layers: keys.into_iter().map(Some).collect(),
        kept,
    }))
}

/// `item` (a kept `rdf:li` correction) with `declarations` on its start tag
/// and `key` as its correction's `papp:LayerOrder`, every other byte as read.
pub fn stamped(
    text: &str,
    item: &Element,
    declarations: &str,
    key: f64,
    scopes: &Scopes,
) -> Result<String, String> {
    let [description] = &item.children[..] else {
        return Err("A kept mask correction has no single description to order".into());
    };
    if !item.is("rdf:li") || !description.is("rdf:Description") {
        return Err("A kept mask correction has no single description to order".into());
    }
    let value = format_key(key);
    let tag = &text[description.start.clone()];
    let existing = description
        .attrs
        .iter()
        .find(|attr| attr.canonical().as_deref() == Some("papp:LayerOrder"));
    let replacement = match existing {
        Some(attr) => {
            let name = match &attr.prefix {
                Some(prefix) => format!("{prefix}:{}", attr.local),
                None => attr.local.clone(),
            };
            let at = tag
                .match_indices(&name)
                .map(|(at, _)| at)
                .find(|at| {
                    tag[..*at].ends_with(char::is_whitespace)
                        && tag[at + name.len()..].trim_start().starts_with('=')
                })
                .ok_or("Unreadable layer order")?;
            let open = at
                + tag[at..]
                    .find(['"', '\''])
                    .ok_or("Unreadable layer order")?;
            let quote = &tag[open..=open];
            let close = open
                + 1
                + tag[open + 1..]
                    .find(quote)
                    .ok_or("Unreadable layer order")?;
            format!("{}{value}{}", &tag[..open + 1], &tag[close..])
        }
        None => {
            let end = tag.len() - if tag.ends_with("/>") { 2 } else { 1 };
            // The bindings at the description as read: detaching the item keeps them.
            let scope = scopes
                .get(&description.start.start)
                .cloned()
                .unwrap_or_default();
            let bound = scope
                .iter()
                .find(|(prefix, uri)| prefix.is_some() && *uri == PAPP)
                .and_then(|(prefix, _)| prefix.clone());
            let attribute = match bound {
                Some(prefix) => format!(" {prefix}:LayerOrder=\"{value}\""),
                None => {
                    let prefix = (0..)
                        .map(|n| match n {
                            0 => "maple_papp".to_owned(),
                            n => format!("maple_papp_{n}"),
                        })
                        .find(|p| !scope.contains_key(&Some(p.clone())))
                        .unwrap_or_default();
                    format!(
                        "{} {prefix}:LayerOrder=\"{value}\"",
                        mask_xml::declaration(Some(&prefix), PAPP)
                    )
                }
            };
            format!("{}{attribute}{}", &tag[..end], &tag[end..])
        }
    };
    let detached = mask_xml::detached(text, item, declarations);
    let offset = declarations.len() + description.start.start - item.span.start;
    Ok(format!(
        "{}{replacement}{}",
        &detached[..offset],
        &detached[offset + tag.len()..]
    ))
}

//! Carrying unknown XML through a canonical rewrite, shared by the mask and
//! repair-spot writers: the attributes and child nodes a writer does not own
//! are re-emitted where the canonical form puts its element, declaring the
//! namespaces they need there.
use crate::mask_document::Bindings;
use crate::mask_xml::{self, Attr, Element};
use std::collections::BTreeMap;

/// `context` with each of `prefixes` bound to its namespace, and the
/// declarations that adds.
pub fn with_prefixes(context: &Bindings, prefixes: &[(&str, &str)]) -> (Bindings, String) {
    let mut merged = context.clone();
    let mut declarations = String::new();
    for (prefix, uri) in prefixes {
        let (prefix, uri) = (Some((*prefix).to_owned()), (*uri).to_owned());
        if context.get(&prefix) != Some(&uri) {
            declarations.push_str(&mask_xml::declaration(prefix.as_deref(), &uri));
            merged.insert(prefix, uri);
        }
    }
    (merged, declarations)
}

/// Where a container rewrite declares the `additions` binding `context` over
/// `inside`, the scope of the container's `seq`.
pub struct Placement<'a> {
    /// Declarations for the container's own tag.
    pub tag: String,
    /// Declarations for each rendered entry's tag.
    pub entry: String,
    /// The scope kept entries are detached into.
    pub kept: &'a Bindings,
}

/// On the container's tag, unless the container or its sequence declares one
/// of the added prefixes itself: that tag cannot declare it again and the
/// sequence's binding would shadow it, so they go on each rendered entry.
pub fn placement<'a>(
    root: &Element,
    seq: &Element,
    inside: &'a Bindings,
    context: &'a Bindings,
    additions: String,
) -> Placement<'a> {
    let own = |prefix: &Option<String>| {
        root.declarations
            .iter()
            .chain(&seq.declarations)
            .any(|(declared, _)| declared == prefix)
    };
    let scoped = context
        .iter()
        .any(|(prefix, uri)| inside.get(prefix) != Some(uri) && own(prefix));
    if scoped {
        Placement {
            tag: String::new(),
            entry: additions,
            kept: inside,
        }
    } else {
        Placement {
            tag: additions,
            entry: String::new(),
            kept: context,
        }
    }
}

pub fn unknown<'a>(attrs: &'a [Attr], owned: &[&str]) -> Vec<&'a Attr> {
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
/// canonical prefix is already taken there. Also returns the bindings in
/// scope below that tag, which its re-emitted descendants are written under.
pub fn attribute_lines(attrs: &[&Attr], context: &Bindings, indent: &str) -> (String, Bindings) {
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
    let mut inner = context.clone();
    inner.extend(
        declared
            .into_iter()
            .map(|(prefix, uri)| (Some(prefix), uri)),
    );
    (declarations + &lines, inner)
}

/// `nodes` cut out of `text` (whose namespace `scopes` they were read in),
/// one per line at `indent`, declaring what `context` does not bind.
pub fn node_lines(
    text: &str,
    scopes: &mask_xml::Scopes,
    nodes: &[&Element],
    context: &Bindings,
    indent: &str,
) -> String {
    nodes
        .iter()
        .map(|node| {
            let declarations = mask_xml::detached_declarations(node, scopes, context);
            format!(
                "{indent}{}\n",
                mask_xml::detached(text, node, &declarations)
            )
        })
        .collect()
}

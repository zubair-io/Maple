//! Fragment emitter for the variants / snapshots / history blocks (#2437) —
//! the write side of `mod.rs`'s walker, split into its own file for the
//! same size-budget reason as the local-adjustments emitter beside it.
//!
//! Like every other raw-core emitter this produces a *fragment*, not a
//! document: the three shells own full-document writing
//! (`docs/xmp-canonical-format.md` § "The four implementations"). An
//! entry's state payload is therefore exactly what [`super::super::serialize`]
//! emits at the top level — the Maple-proprietary `papp:` keys plus the
//! parametric, black-and-white, lens and crop groups — while the Swift,
//! TypeScript and C# writers spell the full `crs:` block into the same
//! slot. Both are the same structure; only the attribute set differs, in
//! exactly the way it already differs for the document itself.

use super::{Block, HistoryEntry, Snapshot, VariantRecord, Variants};
use crate::types::adjustment::AdjustmentModel;
use quick_xml::escape::escape;

/// Emit the `papp:Variants`, `papp:Snapshots` and `papp:History` child
/// elements for `variants`, each line prefixed so the container element
/// sits at `indent` — same contract as
/// [`super::super::serialize_tone_curves`]. Returns the empty string when
/// all three blocks are empty, so a sidecar that never branched keeps the
/// bytes it had before this ticket existed.
pub fn serialize_variants(variants: &Variants, indent: &str) -> String {
    let mut blocks: Vec<String> = Vec::new();
    if !variants.variants.is_empty() {
        let entries: Vec<String> = variants.variants.iter().map(manifest_attrs).collect();
        blocks.push(container(Block::Variants, &entries, &[], indent));
    }
    if !variants.snapshots.is_empty() {
        let entries: Vec<String> = variants.snapshots.iter().map(snapshot_attrs).collect();
        let models: Vec<&AdjustmentModel> = variants.snapshots.iter().map(|s| &s.model).collect();
        blocks.push(container(Block::Snapshots, &entries, &models, indent));
    }
    if !variants.history.is_empty() {
        let entries: Vec<String> = variants.history.iter().map(history_attrs).collect();
        let models: Vec<&AdjustmentModel> = variants.history.iter().map(|h| &h.model).collect();
        blocks.push(container(Block::History, &entries, &models, indent));
    }
    blocks.join("\n")
}

/// One block: container → `rdf:Seq` → one `rdf:li` → `rdf:Description` per
/// entry. `models` is empty for the manifest (a variant record carries no
/// adjustment state) and one model per entry otherwise.
fn container(
    block: Block,
    headers: &[String],
    models: &[&AdjustmentModel],
    indent: &str,
) -> String {
    let name = block.container();
    let i1 = format!("{indent}  ");
    let i2 = format!("{indent}    ");
    let i3 = format!("{indent}      ");
    let i4 = format!("{indent}        ");

    let mut out = format!("{indent}<{name}>\n{i1}<rdf:Seq>\n");
    for (index, header) in headers.iter().enumerate() {
        let state = models
            .get(index)
            .map(|m| super::super::serialize(m))
            .unwrap_or_default();
        let curves = models
            .get(index)
            .map(|m| super::super::serialize_tone_curves(m, &i4))
            .unwrap_or_default();
        out.push_str(&format!("{i2}<rdf:li>\n{i3}<rdf:Description"));
        for (key, value) in attribute_pairs(header)
            .into_iter()
            .chain(attribute_pairs(&state))
        {
            out.push_str(&format!("\n{i4}{key}=\"{value}\""));
        }
        if curves.is_empty() {
            out.push_str("/>\n");
        } else {
            out.push_str(&format!(">\n{curves}\n{i3}</rdf:Description>\n"));
        }
        out.push_str(&format!("{i2}</rdf:li>\n"));
    }
    out.push_str(&format!("{i1}</rdf:Seq>\n{indent}</{name}>"));
    out
}

/// Split an attribute fragment this crate produced back into `(key, value)`
/// pairs so each can be placed on its own line of the canonical ladder.
///
/// Safe because the input is always self-produced and already escaped: a
/// value can therefore never contain a `"`, which makes the closing quote
/// unambiguous. It is not a general XML attribute parser and is not used
/// on foreign input.
fn attribute_pairs(fragment: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let mut rest = fragment;
    while let Some(eq) = rest.find("=\"") {
        let key = rest[..eq].trim();
        let after = &rest[eq + 2..];
        let Some(end) = after.find('"') else { break };
        if !key.is_empty() {
            out.push((key, &after[..end]));
        }
        rest = &after[end + 1..];
    }
    out
}

fn manifest_attrs(record: &VariantRecord) -> String {
    let mut out = format!(r#" papp:VariantId="{}""#, escape(record.id.as_str()));
    if !record.name.is_empty() {
        out.push_str(&format!(
            r#" papp:VariantName="{}""#,
            escape(record.name.as_str())
        ));
    }
    if !record.created.is_empty() {
        out.push_str(&format!(
            r#" papp:VariantCreated="{}""#,
            escape(record.created.as_str())
        ));
    }
    if record.deleted {
        out.push_str(r#" papp:VariantDeleted="True""#);
    }
    out
}

fn snapshot_attrs(snapshot: &Snapshot) -> String {
    let mut out = format!(r#" papp:SnapshotName="{}""#, escape(snapshot.name.as_str()));
    if !snapshot.created.is_empty() {
        out.push_str(&format!(
            r#" papp:SnapshotCreated="{}""#,
            escape(snapshot.created.as_str())
        ));
    }
    out
}

fn history_attrs(entry: &HistoryEntry) -> String {
    let mut out = format!(r#" papp:HistoryKind="{}""#, escape(entry.kind.as_str()));
    if !entry.description.is_empty() {
        out.push_str(&format!(
            r#" papp:HistoryDescription="{}""#,
            escape(entry.description.as_str())
        ));
    }
    if !entry.time.is_empty() {
        out.push_str(&format!(
            r#" papp:HistoryTime="{}""#,
            escape(entry.time.as_str())
        ));
    }
    out
}

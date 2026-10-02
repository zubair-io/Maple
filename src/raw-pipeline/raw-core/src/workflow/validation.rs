use super::{
    SidecarWorkflow, WorkflowHistoryEntry, WorkflowSnapshot, HISTORY_LIMIT, MAX_TIMESTAMP_MS,
    PRIMARY_VARIANT_ID, WORKFLOW_ACTIONS, WORKFLOW_MAX_BYTES, WORKFLOW_VERSION,
};
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use std::collections::HashSet;

pub(super) fn size(value: &str) -> Result<(), String> {
    if value.len() > WORKFLOW_MAX_BYTES {
        return Err(format!("workflow exceeds {WORKFLOW_MAX_BYTES} bytes"));
    }
    Ok(())
}

fn identity(id: &str) -> Result<(), String> {
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
    {
        return Err("workflow identity must be a lowercase UUID".into());
    }
    Ok(())
}

fn name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.bytes().all(|c| c.is_ascii_whitespace())
        || value.chars().any(|c| c.is_control())
    {
        return Err("workflow name/label must contain visible text without controls".into());
    }
    Ok(())
}

fn timestamp(value: u64) -> Result<(), String> {
    // A JS-safe integer is lossless across Rust, Foundation and JSON hosts.
    if value > MAX_TIMESTAMP_MS {
        return Err("workflow timestamp exceeds JSON integer precision".into());
    }
    Ok(())
}

pub(super) fn xml_characters(xml: &str) -> Result<(), String> {
    if xml.chars().any(|c| {
        (c < ' ' && !matches!(c, '\t' | '\n' | '\r')) || matches!(c, '\u{fffe}' | '\u{ffff}')
    }) {
        return Err("invalid XML 1.0 character".into());
    }
    Ok(())
}
fn checkpoint(xml: &str) -> Result<(), String> {
    size(xml)?;
    xml_characters(xml)?;
    let mut reader = NsReader::from_str(xml);
    let mut path: Vec<String> = Vec::new();
    let mut roots = 0;
    let mut description = false;
    loop {
        let event = reader.read_event().map_err(|e| e.to_string())?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let name = e.name();
                let name = std::str::from_utf8(name.as_ref()).map_err(|e| e.to_string())?;
                let (namespace, local) = reader.resolve_element(e.name());
                let owned = matches!(namespace, ResolveResult::Bound(ref ns) if ns.as_ref() == b"http://ns.justmaple.app/photo/1.0/");
                if name == "papp:Workflow" || (owned && local.as_ref() == b"Workflow") {
                    return Err("checkpoint must exclude workflow metadata".into());
                }
                if path.is_empty() {
                    roots += 1;
                    if !matches!(name, "x:xmpmeta" | "rdf:RDF") {
                        return Err("checkpoint must be a complete XMP document".into());
                    }
                }
                if name == "rdf:Description" {
                    description |= path == ["rdf:RDF"] || path == ["x:xmpmeta", "rdf:RDF"];
                }
                if matches!(event, Event::Start(_)) {
                    path.push(name.into());
                }
            }
            Event::End(_) => {
                if path.is_empty() {
                    return Err("unbalanced checkpoint XML".into());
                }
                path.pop();
            }
            Event::Text(t) if path.is_empty() => {
                if !t.unescape().map_err(|e| e.to_string())?.trim().is_empty() {
                    return Err("text outside checkpoint document".into());
                }
            }
            Event::CData(t) if path.is_empty() => {
                let bytes: &[u8] = t.as_ref();
                if !bytes.iter().all(u8::is_ascii_whitespace) {
                    return Err("text outside checkpoint document".into());
                }
            }
            Event::DocType(_) => return Err("checkpoint DTDs are unsupported".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    if roots != 1 || !description || !path.is_empty() {
        return Err("checkpoint must be a complete XMP document".into());
    }
    crate::xmp::parse(xml).map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn snapshot(value: &WorkflowSnapshot) -> Result<(), String> {
    identity(&value.id)?;
    name(&value.name)?;
    timestamp(value.created_at_ms)?;
    checkpoint(&value.adjustment_xmp)
}

pub(super) fn history_entry(value: &WorkflowHistoryEntry) -> Result<(), String> {
    identity(&value.id)?;
    name(&value.label)?;
    timestamp(value.created_at_ms)?;
    if !WORKFLOW_ACTIONS.contains(&value.action.as_str()) {
        return Err(format!(
            "unsupported semantic history action {}",
            value.action
        ));
    }
    checkpoint(&value.adjustment_xmp)
}

pub(super) fn workflow(value: &SidecarWorkflow) -> Result<(), String> {
    if value.schema_version != WORKFLOW_VERSION {
        return Err(format!(
            "unsupported workflow schema version {}",
            value.schema_version
        ));
    }
    if value.variant_id != PRIMARY_VARIANT_ID {
        identity(&value.variant_id)?;
    }
    name(&value.variant_name)?;
    if value.history.len() > HISTORY_LIMIT {
        return Err("history exceeds the committed checkpoint window".into());
    }
    let mut snapshots = HashSet::new();
    for entry in &value.snapshots {
        if !snapshots.insert(&entry.id) {
            return Err("duplicate snapshot identity".into());
        }
        snapshot(entry)?;
    }
    let mut history = HashSet::new();
    for entry in &value.history {
        if !history.insert(&entry.id) {
            return Err("duplicate history identity".into());
        }
        history_entry(entry)?;
    }
    Ok(())
}

use super::{LensModel, LensProfile, LensSample, CAMERA_NS};
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use std::collections::BTreeMap;

const RDF_NS: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const PHOTOSHOP_NS: &str = "http://ns.adobe.com/photoshop/1.0/";
const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_NODES: usize = 200_000;
const MAX_DEPTH: usize = 64;

struct Node {
    namespace: String,
    name: String,
    properties: BTreeMap<String, String>,
    text: String,
    children: Vec<Node>,
}

fn namespace(value: ResolveResult<'_>) -> Result<String, String> {
    match value {
        ResolveResult::Bound(ns) => {
            String::from_utf8(ns.as_ref().to_vec()).map_err(|e| e.to_string())
        }
        ResolveResult::Unbound => Ok(String::new()),
        ResolveResult::Unknown(_) => Err("LCP uses an undeclared namespace prefix".into()),
    }
}

pub(super) fn parse(xml: &str) -> Result<LensProfile, String> {
    if xml.len() > MAX_BYTES {
        return Err("LCP exceeds the 32 MiB document limit".into());
    }
    let mut reader = NsReader::from_str(xml);
    let mut stack: Vec<Node> = Vec::new();
    let mut roots = Vec::new();
    let mut count = 0usize;
    let mut buffer = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| e.to_string())?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                count += 1;
                if count > MAX_NODES || stack.len() >= MAX_DEPTH {
                    return Err("LCP exceeds the XML structure limit".into());
                }
                let (ns, local) = reader.resolve_element(tag.name());
                let mut node = Node {
                    namespace: namespace(ns)?,
                    name: String::from_utf8(local.as_ref().to_vec()).map_err(|e| e.to_string())?,
                    properties: BTreeMap::new(),
                    text: String::new(),
                    children: Vec::new(),
                };
                for attr in tag.attributes() {
                    let attr = attr.map_err(|e| e.to_string())?;
                    if attr.key.as_ref() == b"xmlns" || attr.key.as_ref().starts_with(b"xmlns:") {
                        continue;
                    }
                    let (ns, local) = reader.resolve_attribute(attr.key);
                    if namespace(ns)? == CAMERA_NS {
                        let key = String::from_utf8(local.as_ref().to_vec())
                            .map_err(|e| e.to_string())?;
                        let value = attr
                            .decode_and_unescape_value(reader.decoder())
                            .map_err(|e| e.to_string())?
                            .into_owned();
                        insert(&mut node.properties, key, value)?;
                    }
                }
                if empty {
                    append(node, &mut stack, &mut roots);
                } else {
                    stack.push(node);
                }
            }
            Event::End(_) => {
                let node = stack.pop().ok_or("Unbalanced LCP document")?;
                append(node, &mut stack, &mut roots);
            }
            Event::Text(text) => {
                let value = text.unescape().map_err(|e| e.to_string())?;
                if let Some(node) = stack.last_mut() {
                    node.text.push_str(&value);
                } else if !value.trim().is_empty() {
                    return Err("Text outside the LCP document element".into());
                }
            }
            Event::CData(text) => {
                let node = stack
                    .last_mut()
                    .ok_or("CDATA outside the LCP document element")?;
                node.text
                    .push_str(&text.decode().map_err(|e| e.to_string())?);
            }
            Event::DocType(_) => return Err("DOCTYPE is not supported in LCP files".into()),
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if !stack.is_empty() || roots.len() != 1 {
        return Err("LCP must contain one complete document element".into());
    }
    let mut samples = Vec::new();
    collect(&roots[0], &mut samples)?;
    if samples.is_empty() {
        return Err("No camera-profile calibration samples found".into());
    }
    Ok(LensProfile { samples })
}

fn append(node: Node, stack: &mut [Node], roots: &mut Vec<Node>) {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(node);
    } else {
        roots.push(node);
    }
}

fn insert(
    properties: &mut BTreeMap<String, String>,
    key: String,
    value: String,
) -> Result<(), String> {
    if let Some(previous) = properties.get(&key) {
        if previous != &value {
            return Err(format!("Conflicting LCP property {key}"));
        }
    }
    properties.insert(key, value);
    Ok(())
}

fn collect(node: &Node, samples: &mut Vec<LensSample>) -> Result<(), String> {
    if node.namespace == PHOTOSHOP_NS && node.name == "CameraProfiles" {
        for seq in &node.children {
            if seq.namespace != RDF_NS || seq.name != "Seq" {
                continue;
            }
            for entry in &seq.children {
                if entry.namespace != RDF_NS || entry.name != "li" {
                    continue;
                }
                let containers: Vec<&Node> = if entry
                    .children
                    .iter()
                    .any(|n| n.namespace == RDF_NS && n.name == "Description")
                {
                    entry
                        .children
                        .iter()
                        .filter(|n| n.namespace == RDF_NS && n.name == "Description")
                        .collect()
                } else {
                    vec![entry]
                };
                for container in containers {
                    let model = model(container)?;
                    if model.children.is_empty() {
                        return Err("LCP calibration sample has no model".into());
                    }
                    samples.push(LensSample {
                        properties: model.properties,
                        models: model.children,
                    });
                }
            }
        }
    } else {
        for child in &node.children {
            collect(child, samples)?;
        }
    }
    Ok(())
}

fn model(node: &Node) -> Result<LensModel, String> {
    let mut properties = node.properties.clone();
    let mut children = Vec::new();
    for child in &node.children {
        if child.namespace == CAMERA_NS
            && child.children.is_empty()
            && child.properties.is_empty()
            && (!child.name.ends_with("Model")
                || matches!(child.name.as_str(), "Model" | "UniqueCameraModel"))
        {
            insert(
                &mut properties,
                child.name.clone(),
                child.text.trim().to_owned(),
            )?;
        } else {
            children.push(model(child)?);
        }
    }
    Ok(LensModel {
        namespace: node.namespace.clone(),
        kind: node.name.clone(),
        text: node.text.trim().to_owned(),
        properties,
        children,
    })
}

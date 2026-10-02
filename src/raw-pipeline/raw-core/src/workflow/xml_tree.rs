//! Strict RDF workflow element conversion (#4036). The field table owns names/types.
use super::{WireKind, WorkflowRecord, WORKFLOW_RECORDS};
use quick_xml::{events::Event, Reader};
use serde_json::{Map, Value};

struct Node {
    name: String,
    text: String,
    children: Vec<Node>,
}

pub(super) fn read(xml: &str) -> Result<Value, String> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Node> = Vec::new();
    let mut root = None;
    loop {
        let event = reader.read_event().map_err(|e| e.to_string())?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(event, Event::Empty(_));
                if stack.len() >= 6 {
                    return Err("workflow XML nesting exceeds schema".into());
                }
                for attr in e.attributes() {
                    let attr = attr.map_err(|e| e.to_string())?;
                    let key = std::str::from_utf8(attr.key.as_ref()).map_err(|e| e.to_string())?;
                    if (key == "xmlns:papp"
                        && attr.unescape_value().map_err(|e| e.to_string())?
                            != "http://ns.justmaple.app/photo/1.0/")
                        || (key == "xmlns:rdf"
                            && attr.unescape_value().map_err(|e| e.to_string())?
                                != "http://www.w3.org/1999/02/22-rdf-syntax-ns#")
                    {
                        return Err("unsupported workflow XML namespace".into());
                    }
                    if key != "xmlns"
                        && !key.starts_with("xmlns:")
                        && !(key == "rdf:parseType"
                            && attr.unescape_value().map_err(|e| e.to_string())? == "Resource")
                    {
                        return Err(format!("unknown workflow XML attribute {key}"));
                    }
                }
                let node = Node {
                    name: std::str::from_utf8(e.name().as_ref())
                        .map_err(|e| e.to_string())?
                        .into(),
                    text: String::new(),
                    children: Vec::new(),
                };
                if empty {
                    attach(node, &mut stack, &mut root)?;
                } else {
                    stack.push(node);
                }
            }
            Event::End(_) => {
                let node = stack.pop().ok_or("unbalanced workflow XML")?;
                attach(node, &mut stack, &mut root)?;
            }
            Event::Text(text) => {
                let text = text.unescape().map_err(|e| e.to_string())?;
                if let Some(node) = stack.last_mut() {
                    node.text.push_str(&text);
                } else if !text.trim().is_empty() {
                    return Err("text outside workflow".into());
                }
            }
            Event::CData(text) => {
                let bytes: &[u8] = text.as_ref();
                stack
                    .last_mut()
                    .ok_or("CDATA outside workflow")?
                    .text
                    .push_str(std::str::from_utf8(bytes).map_err(|e| e.to_string())?);
            }
            Event::Comment(_) => return Err("unknown content inside workflow metadata".into()),
            Event::Eof => break,
            _ => return Err("unsupported workflow XML event".into()),
        }
    }
    if !stack.is_empty() {
        return Err("unbalanced workflow XML".into());
    }
    let node = root.ok_or("missing workflow XML")?;
    if node.name != "papp:Workflow" {
        return Err("expected workflow element".into());
    }
    record(&node, "SidecarWorkflow")
}

fn attach(node: Node, stack: &mut [Node], root: &mut Option<Node>) -> Result<(), String> {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(node);
    } else if root.is_some() {
        return Err("multiple workflow roots".into());
    } else {
        *root = Some(node);
    }
    Ok(())
}

fn schema(name: &str) -> Result<&'static WorkflowRecord, String> {
    WORKFLOW_RECORDS
        .iter()
        .find(|record| record.name == name)
        .ok_or_else(|| "unknown workflow record".into())
}
fn tag(field: &str) -> String {
    format!("papp:{}{}", field[..1].to_ascii_uppercase(), &field[1..])
}

fn record(node: &Node, name: &str) -> Result<Value, String> {
    let schema = schema(name)?;
    if !node.text.trim().is_empty() || node.children.len() != schema.fields.len() {
        return Err("missing or unknown workflow XML fields".into());
    }
    let mut out = Map::new();
    for child in &node.children {
        let field = schema
            .fields
            .iter()
            .find(|field| tag(field.name) == child.name)
            .ok_or("unknown workflow XML field")?;
        if out.contains_key(field.name) {
            return Err("duplicate workflow XML field".into());
        }
        let value = match field.kind {
            WireKind::Text => {
                if !child.children.is_empty() {
                    return Err("nested scalar workflow field".into());
                }
                Value::String(child.text.clone())
            }
            WireKind::U32 | WireKind::U64 => {
                if !child.children.is_empty() {
                    return Err("nested scalar workflow field".into());
                }
                Value::from(
                    child
                        .text
                        .trim()
                        .parse::<u64>()
                        .map_err(|e| e.to_string())?,
                )
            }
            WireKind::List(record_name) => {
                if !child.text.trim().is_empty()
                    || child.children.len() != 1
                    || child.children[0].name != "rdf:Seq"
                {
                    return Err("workflow list needs one rdf:Seq".into());
                }
                let seq = &child.children[0];
                if !seq.text.trim().is_empty() {
                    return Err("text inside workflow sequence".into());
                }
                let entries: Result<Vec<_>, _> = seq
                    .children
                    .iter()
                    .map(|entry| {
                        if entry.name != "rdf:li" {
                            return Err("workflow sequence needs rdf:li".into());
                        }
                        record(entry, record_name)
                    })
                    .collect();
                Value::Array(entries?)
            }
        };
        out.insert(field.name.into(), value);
    }
    Ok(Value::Object(out))
}

pub(super) fn write(value: &Value) -> Result<String, String> {
    let mut out = String::from("      <papp:Workflow xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" rdf:parseType=\"Resource\">\n");
    write_record(value, "SidecarWorkflow", 8, &mut out)?;
    out.push_str("      </papp:Workflow>");
    Ok(out)
}
fn write_record(value: &Value, name: &str, indent: usize, out: &mut String) -> Result<(), String> {
    let schema = schema(name)?;
    for field in schema.fields {
        let tag = tag(field.name);
        let pad = " ".repeat(indent);
        let value = &value[field.name];
        match field.kind {
            WireKind::List(record) => {
                out.push_str(&format!("{pad}<{tag}>\n{pad}  <rdf:Seq>\n"));
                for entry in value.as_array().ok_or("invalid workflow list")? {
                    out.push_str(&format!("{pad}    <rdf:li rdf:parseType=\"Resource\">\n"));
                    write_record(entry, record, indent + 6, out)?;
                    out.push_str(&format!("{pad}    </rdf:li>\n"));
                }
                out.push_str(&format!("{pad}  </rdf:Seq>\n{pad}</{tag}>\n"));
            }
            _ => {
                let text = value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string());
                let escaped = quick_xml::escape::escape(&text).replace('\r', "&#13;");
                out.push_str(&format!("{pad}<{tag}>{escaped}</{tag}>\n"));
            }
        }
    }
    Ok(())
}

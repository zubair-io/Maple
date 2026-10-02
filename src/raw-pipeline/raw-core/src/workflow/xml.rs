//! Workflow embedding preserves the surrounding authored XMP (#4036).
use super::{xml_tree, SidecarWorkflow, WORKFLOW_MAX_BYTES};
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use std::ops::Range;

struct Description {
    opening: Range<usize>,
    close: Option<usize>,
}
struct Locations {
    description: Description,
    workflow: Option<Range<usize>>,
}

impl SidecarWorkflow {
    /// Absence stays explicit; the host chooses primary or missing-variant behavior.
    pub fn from_xmp(xml: &str) -> Result<Option<Self>, String> {
        let locations = locate(xml)?;
        let Some(range) = locations.workflow else {
            return Ok(None);
        };
        let value = xml_tree::read(&xml[range])?;
        Self::parse(&value.to_string()).map(Some)
    }

    /// Pure document conversion. The host owns atomic publication, never originals.
    /// Refuse to replace malformed/future records; a successful read precedes replacement.
    pub fn embed_in_xmp(&self, xml: &str) -> Result<String, String> {
        self.validate()?;
        Self::from_xmp(xml)?;
        let locations = locate(xml)?;
        let value = serde_json::to_value(self).map_err(|e| e.to_string())?;
        let element = xml_tree::write(&value)?;
        let output = if let Some(range) = locations.workflow {
            format!(
                "{}{}{}",
                &xml[..range.start],
                element.trim_start(),
                &xml[range.end..]
            )
        } else if let Some(close) = locations.description.close {
            let line = xml[..close].rfind('\n').map_or(close, |index| index + 1);
            let start = if xml[line..close].trim().is_empty() {
                line
            } else {
                close
            };
            let prefix = &xml[..start];
            let separator = if prefix.ends_with('\n') { "" } else { "\n" };
            format!("{prefix}{separator}{element}\n{}", &xml[start..])
        } else {
            let opening = locations.description.opening;
            let prefix = &xml[..opening.end - 2];
            format!(
                "{prefix}>\n{element}\n    </rdf:Description>{}",
                &xml[opening.end..]
            )
        };
        if output.len() > WORKFLOW_MAX_BYTES {
            return Err("workflow sidecar exceeds byte budget".into());
        }
        // Prove complete model readability before a host can publish any bytes.
        raw_readable(&output)?;
        Ok(output)
    }
}

fn raw_readable(xml: &str) -> Result<(), String> {
    if xml.len() > WORKFLOW_MAX_BYTES {
        return Err("workflow sidecar exceeds byte budget".into());
    }
    super::validation::xml_characters(xml)?;
    crate::xmp::parse(xml).map_err(|e| e.to_string())?;
    Ok(())
}
fn locate(xml: &str) -> Result<Locations, String> {
    raw_readable(xml)?;
    let mut reader = NsReader::from_str(xml);
    let mut path: Vec<String> = Vec::new();
    let mut description = None;
    let mut roots = 0;
    let mut workflow = None;
    let mut workflow_start = None;
    loop {
        let start = reader.buffer_position() as usize;
        let event = reader.read_event().map_err(|e| e.to_string())?;
        let end = reader.buffer_position() as usize;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let name = std::str::from_utf8(e.name().as_ref())
                    .map_err(|e| e.to_string())?
                    .to_owned();
                let is_start = matches!(event, Event::Start(_));
                if path.is_empty() {
                    roots += 1;
                    if roots != 1 || !matches!(name.as_str(), "x:xmpmeta" | "rdf:RDF") {
                        return Err("invalid XMP root".into());
                    }
                }
                let parent_is_rdf = path == ["x:xmpmeta", "rdf:RDF"] || path == ["rdf:RDF"];
                if name == "rdf:Description" && parent_is_rdf {
                    if description.is_some() {
                        return Err("multiple primary XMP descriptions".into());
                    }
                    description = Some(Description {
                        opening: start..end,
                        close: None,
                    });
                }
                let (namespace, local) = reader.resolve_element(e.name());
                let owned = matches!(namespace, ResolveResult::Bound(ref ns) if ns.as_ref() == b"http://ns.justmaple.app/photo/1.0/");
                if name == "papp:Workflow" && !owned {
                    return Err("workflow namespace is missing or unsupported".into());
                }
                if owned && local.as_ref() == b"Workflow" {
                    if name != "papp:Workflow" {
                        return Err("workflow namespace needs the canonical papp prefix".into());
                    }
                    let parent_is_description = path == ["x:xmpmeta", "rdf:RDF", "rdf:Description"]
                        || path == ["rdf:RDF", "rdf:Description"];
                    if !parent_is_description || workflow.is_some() || workflow_start.is_some() {
                        return Err("duplicate or misplaced workflow element".into());
                    }
                    if is_start {
                        workflow_start = Some(start);
                    } else {
                        workflow = Some(start..end);
                    }
                }
                if is_start {
                    path.push(name);
                }
            }
            Event::End(e) => {
                let name = e.name();
                if name.as_ref() == b"papp:Workflow" {
                    workflow = Some(workflow_start.take().ok_or("unbalanced workflow XML")?..end);
                }
                if name.as_ref() == b"rdf:Description"
                    && (path == ["x:xmpmeta", "rdf:RDF", "rdf:Description"]
                        || path == ["rdf:RDF", "rdf:Description"])
                {
                    description
                        .as_mut()
                        .ok_or("missing primary description")?
                        .close = Some(start);
                }
                if path.pop().is_none() {
                    return Err("unbalanced XMP document".into());
                }
            }
            Event::Text(text) if path.is_empty() => {
                if !text
                    .unescape()
                    .map_err(|e| e.to_string())?
                    .trim()
                    .is_empty()
                {
                    return Err("text outside XMP document".into());
                }
            }
            Event::CData(text) if path.is_empty() => {
                let bytes: &[u8] = text.as_ref();
                if !bytes.iter().all(u8::is_ascii_whitespace) {
                    return Err("CDATA outside XMP document".into());
                }
            }
            Event::Eof => break,
            Event::DocType(_) => return Err("XMP DTDs are unsupported".into()),
            _ => {}
        }
    }
    if !path.is_empty() || workflow_start.is_some() {
        return Err("unbalanced XMP document".into());
    }
    Ok(Locations {
        description: description.ok_or("missing primary XMP description")?,
        workflow,
    })
}

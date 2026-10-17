//! Primary `rdf:Description` subject selection and sibling eligibility (#4690).
use super::import::{canonical_name, container, flat_key, prefix};
use quick_xml::{
    events::{BytesStart, Event},
    name::ResolveResult,
    NsReader, Reader,
};

#[derive(Clone, Debug, PartialEq, Eq)]
enum Subject {
    About(String),
    NodeId(String),
    Anonymous(usize),
}

struct DescCandidate {
    subject: Subject,
    tier: u8,
    score: usize,
}

impl DescCandidate {
    fn from_attrs(
        idx: usize,
        about: Option<String>,
        node_id: Option<String>,
        score: usize,
    ) -> Self {
        let (subject, tier) = match (about, node_id) {
            (Some(a), None) => {
                let tier = if a.is_empty() { 2 } else { 0 };
                (Subject::About(a), tier)
            }
            (None, None) => (Subject::Anonymous(idx), 1),
            (None, Some(n)) => (Subject::NodeId(n), 0),
            (Some(_), Some(_)) => (Subject::Anonymous(idx), 0),
        };
        Self {
            subject,
            tier,
            score,
        }
    }
}

pub(super) fn is_description_name(name: &str) -> bool {
    name == "rdf:Description" || name == "Description" || name.ends_with(":Description")
}

pub(super) fn is_rdf_name(name: &str) -> bool {
    name == "rdf:RDF" || name == "RDF" || name.ends_with(":RDF")
}

fn eligible_from_candidates(descs: &[DescCandidate]) -> Vec<bool> {
    let Some(primary) = descs.iter().reduce(|best, cand| {
        if (cand.tier, cand.score) > (best.tier, best.score) {
            cand
        } else {
            best
        }
    }) else {
        return Vec::new();
    };
    descs.iter().map(|d| d.subject == primary.subject).collect()
}

pub(super) fn eligible_descriptions(xml: &str, strict: bool) -> Vec<bool> {
    if strict {
        eligible_strict(xml)
    } else {
        eligible_lenient(xml)
    }
}

fn inspect_strict_desc(reader: &NsReader<&[u8]>, e: &BytesStart<'_>, idx: usize) -> DescCandidate {
    let mut about = None;
    let mut node_id = None;
    let mut score = 0usize;
    for attr in e.attributes().flatten() {
        let raw = attr.key.as_ref();
        if raw == b"xmlns" || raw.starts_with(b"xmlns:") {
            continue;
        }
        let (res, loc) = reader.resolve_attribute(attr.key);
        let is_rdf =
            matches!(res, ResolveResult::Bound(uri) if prefix(uri.as_ref()) == Some("rdf"));
        let is_unbound = matches!(res, ResolveResult::Unbound);
        if (is_rdf || (is_unbound && about.is_none())) && loc.as_ref() == b"about" {
            about = Some(
                attr.unescape_value()
                    .map(|s| s.into_owned())
                    .unwrap_or_default(),
            );
        } else if (is_rdf || (is_unbound && node_id.is_none())) && loc.as_ref() == b"nodeID" {
            node_id = Some(
                attr.unescape_value()
                    .map(|s| s.into_owned())
                    .unwrap_or_default(),
            );
        }
        if let Ok(Some(key)) = canonical_name(res, &loc) {
            if (key.starts_with("crs:") || key.starts_with("papp:")) && flat_key(&key) {
                score += 1;
            }
        }
    }
    DescCandidate::from_attrs(idx, about, node_id, score)
}

fn eligible_strict(xml: &str) -> Vec<bool> {
    let mut reader = NsReader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut stack: Vec<Option<String>> = Vec::new();
    let mut active_desc: Option<(usize, usize)> = None;
    let mut descs: Vec<DescCandidate> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let (res, loc) = reader.resolve_element(e.name());
                let canonical = canonical_name(res, &loc).ok().flatten();
                if let Some((idx, d)) = active_desc {
                    if stack.len() == d + 1 && canonical.as_deref().is_some_and(container) {
                        descs[idx].score += 1;
                    }
                } else if canonical.as_deref() == Some("rdf:Description")
                    && stack.last().is_none_or(|p| p.as_deref() == Some("rdf:RDF"))
                {
                    let idx = descs.len();
                    descs.push(inspect_strict_desc(&reader, &e, idx));
                    active_desc = Some((idx, stack.len()));
                }
                stack.push(canonical);
            }
            Ok(Event::Empty(e)) => {
                let (res, loc) = reader.resolve_element(e.name());
                let canonical = canonical_name(res, &loc).ok().flatten();
                if let Some((idx, d)) = active_desc {
                    if stack.len() == d + 1 && canonical.as_deref().is_some_and(container) {
                        descs[idx].score += 1;
                    }
                } else if canonical.as_deref() == Some("rdf:Description")
                    && stack.last().is_none_or(|p| p.as_deref() == Some("rdf:RDF"))
                {
                    let idx = descs.len();
                    descs.push(inspect_strict_desc(&reader, &e, idx));
                }
            }
            Ok(Event::End(_)) => {
                stack.pop();
                if active_desc.is_some_and(|(_, d)| stack.len() == d) {
                    active_desc = None;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    eligible_from_candidates(&descs)
}

fn inspect_lenient_desc(e: &BytesStart<'_>, idx: usize) -> DescCandidate {
    let mut about = None;
    let mut node_id = None;
    let mut score = 0usize;
    for attr in e.attributes().flatten() {
        let Ok(key) = std::str::from_utf8(attr.key.as_ref()) else {
            continue;
        };
        if key == "xmlns" || key.starts_with("xmlns:") {
            continue;
        }
        if key == "rdf:about" || (key == "about" && about.is_none()) {
            about = Some(
                attr.unescape_value()
                    .map(|s| s.into_owned())
                    .unwrap_or_default(),
            );
        } else if key == "rdf:nodeID" || (key == "nodeID" && node_id.is_none()) {
            node_id = Some(
                attr.unescape_value()
                    .map(|s| s.into_owned())
                    .unwrap_or_default(),
            );
        }
        if (key.starts_with("crs:") || key.starts_with("papp:")) && flat_key(key) {
            score += 1;
        }
    }
    DescCandidate::from_attrs(idx, about, node_id, score)
}

fn eligible_lenient(xml: &str) -> Vec<bool> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut stack: Vec<String> = Vec::new();
    let mut workflow_depth = 0usize;
    let mut active_desc: Option<(usize, usize)> = None;
    let mut descs: Vec<DescCandidate> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let Ok(name) = super::element_name(&e) else {
                    break;
                };
                let name = name.to_string();
                if workflow_depth > 0 || name == "papp:Workflow" {
                    workflow_depth += 1;
                    continue;
                }
                if let Some((idx, d)) = active_desc {
                    if stack.len() == d + 1 && container(&name) {
                        descs[idx].score += 1;
                    }
                } else if stack.last().is_none_or(|p| is_rdf_name(p)) && is_description_name(&name)
                {
                    let idx = descs.len();
                    descs.push(inspect_lenient_desc(&e, idx));
                    active_desc = Some((idx, stack.len()));
                }
                stack.push(name);
            }
            Ok(Event::Empty(e)) => {
                let Ok(name) = super::element_name(&e) else {
                    break;
                };
                if workflow_depth > 0 || name == "papp:Workflow" {
                    continue;
                }
                if let Some((idx, d)) = active_desc {
                    if stack.len() == d + 1 && container(name) {
                        descs[idx].score += 1;
                    }
                } else if stack.last().is_none_or(|p| is_rdf_name(p)) && is_description_name(name) {
                    let idx = descs.len();
                    descs.push(inspect_lenient_desc(&e, idx));
                }
            }
            Ok(Event::End(_)) => {
                if workflow_depth > 0 {
                    workflow_depth -= 1;
                    continue;
                }
                stack.pop();
                if active_desc.is_some_and(|(_, d)| stack.len() == d) {
                    active_desc = None;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    eligible_from_candidates(&descs)
}

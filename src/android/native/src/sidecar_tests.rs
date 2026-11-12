//! Stand-ins for the Kotlin lexical reader/writer in the native tests: they
//! cut a sidecar's primary-description children out with their namespace
//! scope, as `XmpDocument` does, and splice a writer's output back.
use crate::mask_xml::canonical_name;
use quick_xml::events::Event;
use quick_xml::name::{PrefixDeclaration, ResolveResult};
use quick_xml::NsReader;
use serde_json::{json, Value};
use std::ffi::{c_char, CStr, CString};
use std::ops::Range;

/// Persists `xml` as a sidecar and reads it back from disk.
pub(crate) fn through_file_of(xml: &str, names: &[&str]) -> Sidecar {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "android-sidecar-{}-{}.xmp",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::write(&path, xml).unwrap();
    let back = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    sidecar_of(&back, names)
}

/// The writer's `output` spliced into `document` the way `XmpDocument` does.
pub(crate) fn splice(document: &Sidecar, output: &Value) -> String {
    let appended: String = output["appended"]
        .as_array()
        .unwrap()
        .iter()
        .map(|container| format!("\n{INDENT}{}", container.as_str().unwrap()))
        .collect();
    let mut xml = document.xml.clone();
    xml.insert_str(document.close, &appended);
    for (span, replacement) in document
        .spans
        .iter()
        .zip(output["containers"].as_array().unwrap())
        .rev()
    {
        let replacement = replacement.as_str().unwrap();
        let start = if replacement.is_empty() {
            xml[..span.start].trim_end().len()
        } else {
            span.start
        };
        xml.replace_range(start..span.end, replacement);
    }
    xml
}
pub(crate) fn call(
    entry: unsafe extern "C" fn(*const c_char) -> *mut c_char,
    input: &Value,
) -> Value {
    let input = CString::new(input.to_string()).unwrap();
    let raw = unsafe { entry(input.as_ptr()) };
    assert!(
        !raw.is_null(),
        "{}",
        unsafe { CStr::from_ptr(crate::maple_android_error()) }
            .to_str()
            .unwrap()
    );
    let text = unsafe { CStr::from_ptr(raw) }.to_str().unwrap().to_owned();
    unsafe { crate::maple_android_free_string(raw) };
    serde_json::from_str(&text).unwrap()
}

/// `xml`'s primary-description children named in `names`, cut out with their scope.
pub(crate) fn sidecar_of(xml: &str, names: &[&str]) -> Sidecar {
    let mut reader = NsReader::from_str(xml);
    let (mut depth, mut spans, mut containers, mut close) = (0, Vec::new(), Vec::new(), 0);
    let (mut description_depth, mut open, mut target) = (0, None, json!({}));
    loop {
        let before = reader.buffer_position() as usize;
        let (namespace, event) = reader.read_resolved_event().unwrap();
        let uri = match namespace {
            ResolveResult::Bound(ns) => Some(String::from_utf8(ns.0.to_vec()).unwrap()),
            _ => None,
        };
        let after = reader.buffer_position() as usize;
        let (start, empty) = match &event {
            Event::Start(e) => (Some(e), false),
            Event::Empty(e) => (Some(e), true),
            _ => (None, false),
        };
        if let Some(e) = start {
            let local = String::from_utf8(e.local_name().into_inner().to_vec()).unwrap();
            let name = canonical_name(uri.as_deref(), &local);
            if name.as_deref() == Some("rdf:Description") && depth == 2 {
                description_depth = depth + 1;
                target = scope(&reader);
            } else if depth == description_depth
                && name.as_deref().is_some_and(|n| names.contains(&n))
            {
                open = Some((before, scope(&reader)));
            }
            if !empty {
                depth += 1;
            } else if open.as_ref().is_some_and(|(at, _)| *at == before) {
                let (at, scope) = open.take().unwrap();
                spans.push(at..after);
                containers.push(json!({"scope": scope, "xml": &xml[at..after]}));
            }
        }
        match event {
            Event::End(_) => {
                depth -= 1;
                if depth == description_depth {
                    if let Some((start, scope)) = open.take() {
                        spans.push(start..after);
                        containers.push(json!({"scope": scope, "xml": &xml[start..after]}));
                    }
                }
                if depth + 1 == description_depth {
                    close = xml[..before].trim_end().len();
                    description_depth = 0;
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let input = json!({"target": target, "containers": containers, "indent": INDENT});
    Sidecar {
        xml: xml.to_owned(),
        spans,
        close,
        input,
    }
}
pub(crate) struct Sidecar {
    pub xml: String,
    pub spans: Vec<Range<usize>>,
    close: usize,
    pub input: Value,
}

fn scope(reader: &NsReader<&[u8]>) -> Value {
    Value::Object(
        reader
            .prefixes()
            .map(|(prefix, ns)| {
                let prefix = match prefix {
                    PrefixDeclaration::Default => String::new(),
                    PrefixDeclaration::Named(p) => String::from_utf8(p.to_vec()).unwrap(),
                };
                (prefix, json!(String::from_utf8(ns.0.to_vec()).unwrap()))
            })
            .collect(),
    )
}

pub(crate) const INDENT: &str = "      ";

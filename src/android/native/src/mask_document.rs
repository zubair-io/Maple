//! The sidecar's mask containers as Android sees them: every correction
//! raw-core reads, which of them Android authors, and the source XML each
//! came from. Input is JSON from the Kotlin lexical reader:
//! `{"target": {prefix: uri}, "containers": [{"scope": {prefix: uri},
//! "xml": "<crs:…Corrections>…"}], "legacy": "…"?}` — each container is the
//! source text of one direct child of a primary `rdf:Description`, `scope`
//! the namespaces in force there (`""` is the default namespace).
use crate::mask_model::{authorable, AuthoredLayer};
use crate::mask_order::parse_key;
use crate::mask_xml::{self, Element, Scopes, RDF};
use raw_core::types::{LocalAdjustment, Mask};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Bindings = BTreeMap<Option<String>, String>;

/// Container names in canonical emit order; the index is the container rank.
pub const CONTAINERS: [&str; 4] = [
    "crs:GradientBasedCorrections",
    "crs:CircularGradientBasedCorrections",
    "papp:BrushCorrections",
    "crs:MaskGroupBasedCorrections",
];

pub struct Container {
    pub text: String,
    pub root: Element,
    pub scopes: Scopes,
    pub rank: Option<usize>,
    /// The `rdf:Seq` when the container holds nothing but corrections, so
    /// Android may edit, remove and append its entries.
    pub seq: Option<Element>,
    /// Corrections raw-core models in a container without a clean sequence:
    /// Android can neither move nor key them.
    pub opaque: usize,
}

pub struct Correction {
    pub container: usize,
    pub item: usize,
    /// raw-core's reading; `None` when raw-core drops the correction.
    pub layer: Option<LocalAdjustment>,
    pub key: Option<f64>,
    /// The correction description and its mask leaves when Android authors
    /// the correction; anything else stays verbatim.
    pub authored: Option<(Element, Vec<Element>)>,
}

pub struct Document {
    pub containers: Vec<Container>,
    pub corrections: Vec<Correction>,
    pub target: Bindings,
    /// Keys of corrections and containers kept verbatim.
    pub verbatim_keys: Vec<f64>,
    /// Whether every correction raw-core models carries a valid key, so it
    /// reads the stack in key order rather than document order.
    pub all_keyed: bool,
    /// Whether a correction Android keeps verbatim is modeled but unkeyed, so
    /// keying Android's layers alone never makes raw-core read keys.
    pub verbatim_unkeyed: bool,
    /// Whether raw-core models any correction at all; when none, it falls
    /// back to the legacy `papp:LocalAdjustments` attribute.
    pub any_modeled: bool,
    pub legacy: Option<String>,
}

pub fn bindings(value: Option<&Value>) -> Result<Bindings, String> {
    let Some(map) = value else {
        return Ok(Bindings::new());
    };
    map.as_object()
        .ok_or("Namespace scope must be an object")?
        .iter()
        .map(|(prefix, uri)| {
            let uri = uri.as_str().ok_or("Namespace URI must be text")?;
            Ok(((!prefix.is_empty()).then(|| prefix.clone()), uri.to_owned()))
        })
        .collect()
}

pub fn declarations(scope: &Bindings) -> String {
    scope
        .iter()
        .map(|(prefix, uri)| mask_xml::declaration(prefix.as_deref(), uri))
        .collect()
}

fn single_layer(piece: &str, scope: &Bindings) -> Result<Vec<LocalAdjustment>, String> {
    let declarations: String = scope
        .iter()
        .filter(|(prefix, _)| prefix.as_deref() != Some("rdf"))
        .map(|(prefix, uri)| mask_xml::declaration(prefix.as_deref(), uri))
        .collect();
    let xml = format!(
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"{RDF}\"><rdf:Description rdf:about=\"\"{declarations}>{piece}</rdf:Description></rdf:RDF></x:xmpmeta>"
    );
    Ok(raw_core::xmp::parse_namespaced(&xml)
        .map_err(|e| e.to_string())?
        .local_adjustments)
}

fn layer_key(description: &Element) -> Option<f64> {
    description
        .attrs
        .iter()
        .find(|attr| attr.canonical().as_deref() == Some("papp:LayerOrder"))
        .and_then(|attr| parse_key(&attr.raw))
}

fn all_keys(element: &Element, out: &mut Vec<f64>) {
    if element.is("rdf:Description") {
        out.extend(layer_key(element));
    }
    for child in &element.children {
        all_keys(child, out);
    }
}

/// The correction description and mask leaves of an entry whose structure
/// carries nothing Android would have to drop when it rewrites the entry.
fn authored_structure(item: &Element) -> Option<(Element, Vec<Element>)> {
    if !item.is("rdf:li") || item.has_attributes() || item.mixed || item.children.len() != 1 {
        return None;
    }
    let description = &item.children[0];
    if !description.is("rdf:Description") || description.mixed {
        return None;
    }
    let masks: Vec<&Element> = description
        .children
        .iter()
        .filter(|child| child.is("crs:CorrectionMasks"))
        .collect();
    let [masks] = masks[..] else { return None };
    if masks.has_attributes() || masks.mixed || masks.children.len() != 1 {
        return None;
    }
    let seq = &masks.children[0];
    if !seq.is("rdf:Seq") || seq.has_attributes() || seq.mixed {
        return None;
    }
    if seq
        .children
        .iter()
        .any(|leaf| !leaf.is("rdf:li") || leaf.mixed)
    {
        return None;
    }
    Some((description.clone(), seq.children.clone()))
}

fn component_count(mask: &Mask) -> usize {
    match mask {
        Mask::Group(group) => group.components.len(),
        _ => 1,
    }
}

fn clean_sequence(root: &Element) -> Option<Element> {
    if root.has_attributes() || root.mixed || root.children.len() != 1 {
        return None;
    }
    let seq = &root.children[0];
    (seq.is("rdf:Seq") && !seq.has_attributes() && !seq.self_closing()).then(|| seq.clone())
}

impl Document {
    pub fn read(input: &Value) -> Result<Self, String> {
        let target = bindings(input.get("target"))?;
        let legacy = input
            .get("legacy")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut document = Document {
            containers: Vec::new(),
            corrections: Vec::new(),
            target,
            verbatim_keys: Vec::new(),
            all_keyed: true,
            verbatim_unkeyed: false,
            any_modeled: false,
            legacy,
        };
        let sources = match input.get("containers") {
            None | Some(Value::Null) => &[][..],
            Some(value) => value.as_array().ok_or("Mask containers must be a list")?,
        };
        for source in sources {
            document.add_container(source)?;
        }
        Ok(document)
    }

    fn add_container(&mut self, source: &Value) -> Result<(), String> {
        let scope = bindings(source.get("scope"))?;
        let xml = source
            .get("xml")
            .and_then(Value::as_str)
            .ok_or("Mask container has no XML")?;
        let text = format!("<_maple_scope{}>{xml}</_maple_scope>", declarations(&scope));
        let mut roots = mask_xml::parse(&text)?;
        let wrapper = roots
            .pop()
            .filter(|w| roots.is_empty() && !w.mixed && w.children.len() == 1)
            .ok_or("A mask container must be one element")?;
        let scopes = mask_xml::scopes(std::slice::from_ref(&wrapper));
        let root = wrapper
            .children
            .into_iter()
            .next()
            .ok_or("Empty mask container")?;
        let rank = root
            .canonical()
            .and_then(|name| CONTAINERS.iter().position(|c| *c == name));
        let seq = rank.and_then(|_| clean_sequence(&root));
        let index = self.containers.len();
        let mut opaque = 0;
        match (&seq, rank) {
            (Some(seq), Some(rank)) => {
                let close = text[..seq.span.end]
                    .rfind("</")
                    .ok_or("Malformed sequence")?;
                // raw-core drops a whole brush container when any one stroke is unreadable.
                let whole =
                    rank != 2 || !single_layer(&text[root.span.clone()], &scope)?.is_empty();
                for (item_index, item) in seq.children.iter().enumerate() {
                    let piece = format!(
                        "{}{}{}",
                        &text[root.start.start..seq.start.end],
                        &text[item.span.clone()],
                        &text[close..root.span.end]
                    );
                    let layers = single_layer(&piece, &scope)?;
                    let structure = authored_structure(item);
                    let key = structure
                        .as_ref()
                        .map(|(description, _)| layer_key(description))
                        .unwrap_or_else(|| {
                            let mut keys = Vec::new();
                            all_keys(item, &mut keys);
                            keys.first().copied()
                        });
                    let layer = layers.into_iter().next().filter(|_| whole);
                    let authored = match (&layer, structure) {
                        (Some(layer), Some((description, leaves)))
                            if rank != 2
                                && authorable(&layer.mask)
                                && leaves.len() == component_count(&layer.mask) =>
                        {
                            Some((description, leaves))
                        }
                        _ => None,
                    };
                    if layer.is_some() {
                        self.any_modeled = true;
                        if key.is_none() {
                            self.all_keyed = false;
                            self.verbatim_unkeyed |= authored.is_none();
                        }
                    }
                    if authored.is_none() {
                        self.verbatim_keys.extend(key);
                    }
                    self.corrections.push(Correction {
                        container: index,
                        item: item_index,
                        layer,
                        key,
                        authored,
                    });
                }
            }
            _ => {
                let modeled = single_layer(&text[root.span.clone()], &scope)?.len();
                opaque = modeled;
                self.any_modeled |= modeled > 0;
                let mut keys = Vec::new();
                all_keys(&root, &mut keys);
                if keys.len() < modeled {
                    self.all_keyed = false;
                    self.verbatim_unkeyed = true;
                }
                self.verbatim_keys.extend(keys);
            }
        }
        self.containers.push(Container {
            text,
            root,
            scopes,
            rank,
            seq,
            opaque,
        });
        Ok(())
    }

    /// Android's layers in raw-core's model order.
    pub fn layers(&self) -> Result<Vec<AuthoredLayer>, String> {
        if !self.any_modeled {
            if let Some(legacy) = &self.legacy {
                return Ok(
                    raw_core::types::local_adjustment::decode_local_adjustments(legacy)?
                        .into_iter()
                        .filter(|layer| authorable(&layer.mask))
                        .map(|layer| AuthoredLayer {
                            sources: vec![None; component_count(&layer.mask)],
                            layer,
                            slot: None,
                        })
                        .collect(),
                );
            }
        }
        let mut layers: Vec<(Option<f64>, AuthoredLayer)> = self
            .corrections
            .iter()
            .enumerate()
            .filter_map(|(slot, correction)| {
                let (_, leaves) = correction.authored.as_ref()?;
                Some((
                    correction.key,
                    AuthoredLayer {
                        layer: correction.layer.clone()?,
                        slot: Some(slot),
                        sources: (0..leaves.len()).map(Some).collect(),
                    },
                ))
            })
            .collect();
        if self.all_keyed {
            layers.sort_by(|a, b| a.0.unwrap_or(0.0).total_cmp(&b.0.unwrap_or(0.0)));
        }
        Ok(layers.into_iter().map(|(_, layer)| layer).collect())
    }
}

//! The sidecar's repair spots as Android authors them (#5904). Input is the
//! Kotlin lexical reader's JSON, the same shape the mask entries take:
//! `{"target": {prefix: uri}, "containers": [{"scope": {...}, "xml":
//! "<crs:RetouchAreas>…"}], "indent": "…"}`, each container one direct child
//! of a primary description (`crs:RetouchAreas` or Lightroom's legacy
//! `crs:RetouchInfo`).
//!
//! raw-core decides what every entry means (`xmp/retouch`): each entry is
//! read on its own through `parse_namespaced`, so the spots Android lists are
//! exactly the ones the renderer applies. An entry raw-core models whose
//! structure is one description with one circular leaf is authored; any
//! other entry stays verbatim in place. When no structured entry is modelled
//! raw-core falls back to the legacy strings, and so does Android: an edit
//! then converts that list to the structured container
//! (`docs/xmp-canonical-format.md` § "Repair spots").
//!
//! Writing them back is `retouch_write.rs`.
use crate::mask_document::{
    bindings, clean_sequence, parse_container, parse_piece, single_item, Bindings,
};
use crate::mask_xml::{Element, Scopes};
use raw_core::image::ExifOrientation;
use raw_core::pipeline::mask::display_to_sensor_norm;
use raw_core::types::{Point2, RetouchKind, RetouchSpot};
use serde_json::{json, Value};

pub const AREAS: &str = "crs:RetouchAreas";
const LEGACY: &str = "crs:RetouchInfo";

pub struct Container {
    pub text: String,
    pub root: Element,
    pub scopes: Scopes,
    /// The namespaces in force where the container sits.
    pub scope: Bindings,
    /// The `rdf:Seq` of a structured container holding nothing else.
    pub seq: Option<Element>,
}

/// An unstamped Maple list raw-core reads in the legacy sensor frame
/// (`docs/xmp-canonical-format.md` § "Frame stamp") on a RAW whose EXIF
/// orientation moves it: Android lists and writes its spots upright.
#[derive(Clone, Copy)]
pub struct SensorFrame {
    orientation: ExifOrientation,
    /// Upright `width / height`.
    aspect: f32,
}

impl SensorFrame {
    fn from_json(value: Option<&Value>) -> Result<Option<Self>, String> {
        let Some(value) = value.filter(|v| !v.is_null()) else {
            return Ok(None);
        };
        let code = value
            .get("orientation")
            .and_then(Value::as_u64)
            .and_then(|code| u16::try_from(code).ok())
            .ok_or("The repair frame needs an EXIF orientation")?;
        let aspect = number(value.get("aspect").unwrap_or(&Value::Null), "aspect")?;
        if aspect <= 0.0 {
            return Err("The repair frame needs a positive aspect".into());
        }
        let orientation = ExifOrientation::from_u16(code);
        Ok((orientation != ExifOrientation::Normal).then_some(Self {
            orientation,
            aspect,
        }))
    }

    /// `spot` read in the sensor frame, re-expressed over the upright image:
    /// the inverse of raw-core's `orient_spots_to_sensor`, so it renders on
    /// the same pixels once the list is stamped upright.
    pub fn upright(self, spot: RetouchSpot) -> RetouchSpot {
        let inverse = match self.orientation {
            ExifOrientation::Rotate90 => ExifOrientation::Rotate270,
            ExifOrientation::Rotate270 => ExifOrientation::Rotate90,
            other => other,
        };
        // The radius is a fraction of the width: the sensor width is the upright height when
        // the orientation swaps the axes.
        let scale = if self.orientation.swaps_wh() {
            1.0 / self.aspect
        } else {
            1.0
        };
        RetouchSpot {
            center: display_to_sensor_norm(spot.center, inverse),
            source: display_to_sensor_norm(spot.source, inverse),
            radius: spot.radius * scale,
            ..spot
        }
    }
}

pub struct Entry {
    pub container: usize,
    pub item: usize,
    pub spot: Option<RetouchSpot>,
    /// The description and circular leaf of an entry Android rewrites.
    pub authored: Option<(Element, Element)>,
}

pub struct Document {
    pub containers: Vec<Container>,
    pub entries: Vec<Entry>,
    /// raw-core models a structured spot, so the legacy strings are ignored.
    pub any_areas: bool,
    /// The last structured container without a clean sequence that models a spot.
    pub last_opaque: Option<usize>,
    legacy: Vec<RetouchSpot>,
    /// Legacy containers that decode to at least one spot.
    pub legacy_containers: Vec<usize>,
    pub target: Bindings,
    pub frame: Option<SensorFrame>,
}

fn authored_structure(item: &Element) -> Option<(Element, Element)> {
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
        .filter(|child| child.is("crs:Masks"))
        .collect();
    let [masks] = masks[..] else { return None };
    if masks.has_attributes() || masks.mixed || masks.children.len() != 1 {
        return None;
    }
    let seq = &masks.children[0];
    if !seq.is("rdf:Seq") || seq.has_attributes() || seq.mixed || seq.children.len() != 1 {
        return None;
    }
    let leaf = &seq.children[0];
    if !leaf.is("rdf:li") || leaf.mixed {
        return None;
    }
    Some((description.clone(), leaf.clone()))
}

impl Document {
    pub fn read(input: &Value) -> Result<Self, String> {
        let mut document = Document {
            containers: Vec::new(),
            entries: Vec::new(),
            any_areas: false,
            last_opaque: None,
            legacy: Vec::new(),
            legacy_containers: Vec::new(),
            target: bindings(input.get("target"))?,
            frame: SensorFrame::from_json(input.get("frame"))?,
        };
        let sources = match input.get("containers") {
            None | Some(Value::Null) => &[][..],
            Some(value) => value.as_array().ok_or("Repair containers must be a list")?,
        };
        for source in sources {
            document.add_container(source)?;
        }
        Ok(document)
    }

    fn add_container(&mut self, source: &Value) -> Result<(), String> {
        let (text, root, scopes, scope) = parse_container(source)?;
        let name = root.canonical();
        let areas = name.as_deref() == Some(AREAS);
        if !areas && name.as_deref() != Some(LEGACY) {
            return Err("Not a repair-spot container".into());
        }
        let index = self.containers.len();
        let seq = if areas { clean_sequence(&root) } else { None };
        match &seq {
            Some(seq) => {
                for (item_index, item) in seq.children.iter().enumerate() {
                    let piece = single_item(&text, &root, seq, item)?;
                    let spot = parse_piece(&piece, &scope)?.retouch_spots.first().copied();
                    self.any_areas |= spot.is_some();
                    self.entries.push(Entry {
                        container: index,
                        item: item_index,
                        spot,
                        authored: spot.and_then(|_| authored_structure(item)),
                    });
                }
            }
            None => {
                let spots = parse_piece(&text[root.span.clone()], &scope)?.retouch_spots;
                if areas {
                    self.any_areas |= !spots.is_empty();
                    if !spots.is_empty() {
                        self.last_opaque = Some(index);
                    }
                } else if !spots.is_empty() {
                    self.legacy.extend(spots);
                    self.legacy_containers.push(index);
                }
            }
        }
        self.containers.push(Container {
            text,
            root,
            scopes,
            scope,
            seq,
        });
        Ok(())
    }

    /// The spots Android lists, in raw-core's order and over the upright image,
    /// with the entry each was read from.
    pub fn spots(&self) -> Vec<(RetouchSpot, Option<usize>)> {
        let upright = |spot: RetouchSpot| self.frame.map_or(spot, |frame| frame.upright(spot));
        if !self.any_areas {
            return self
                .legacy
                .iter()
                .map(|spot| (upright(*spot), None))
                .collect();
        }
        self.entries
            .iter()
            .enumerate()
            .filter_map(|(slot, entry)| {
                entry.authored.as_ref()?;
                Some((upright(entry.spot?), Some(slot)))
            })
            .collect()
    }

    /// The entry at `slot` with its description and leaf, when Android authors it.
    pub fn authored(&self, slot: usize) -> Option<(&Entry, &Element, &Element)> {
        let entry = self.entries.get(slot)?;
        let (description, leaf) = entry.authored.as_ref()?;
        Some((entry, description, leaf))
    }
}

pub fn spot_json(spot: &RetouchSpot, slot: Option<usize>) -> Value {
    json!({
        "kind": spot.kind.wire(),
        "center": [spot.center.x, spot.center.y],
        "source": [spot.source.x, spot.source.y],
        "radius": spot.radius,
        "feather": spot.feather,
        "opacity": spot.opacity,
        "slot": slot,
    })
}

fn number(value: &Value, key: &str) -> Result<f32, String> {
    let n = value
        .as_f64()
        .ok_or_else(|| format!("Repair spot {key} must be a number"))? as f32;
    n.is_finite()
        .then_some(n)
        .ok_or_else(|| format!("Repair spot {key} must be finite"))
}

fn point(value: &Value, key: &str) -> Result<Point2, String> {
    match value.get(key).and_then(Value::as_array).map(Vec::as_slice) {
        Some([x, y]) => Ok(Point2::new(number(x, key)?, number(y, key)?)),
        _ => Err(format!("Repair spot {key} must be [x, y]")),
    }
}

pub fn spot_from_json(value: &Value) -> Result<(RetouchSpot, Option<usize>), String> {
    let field = |key: &str| number(value.get(key).unwrap_or(&Value::Null), key);
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .and_then(RetouchKind::from_wire)
        .ok_or("Unknown repair spot kind")?;
    let spot = RetouchSpot {
        kind,
        center: point(value, "center")?,
        source: point(value, "source")?,
        radius: field("radius")?,
        feather: field("feather")?,
        opacity: field("opacity")?,
    };
    if spot.radius <= 0.0 {
        return Err("A repair spot needs a positive radius".into());
    }
    let slot = match value.get("slot") {
        None | Some(Value::Null) => None,
        Some(slot) => Some(slot.as_u64().ok_or("Repair spot slot must be an index")? as usize),
    };
    Ok((spot, slot))
}

pub fn read(input: &Value) -> Result<Value, String> {
    let spots = Document::read(input)?.spots();
    Ok(
        json!({"spots": spots.iter().map(|(spot, slot)| spot_json(spot, *slot)).collect::<Vec<_>>()}),
    )
}

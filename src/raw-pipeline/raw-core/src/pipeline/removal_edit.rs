//! Saved operation controls (#3984): cold, shared metadata work. Accepted
//! pixels never regenerate here; hosts confirm assets/XMP before adopting it.
use crate::types::{
    accepted_removal::{ContentDigest, RemovalOperation, RemovalPlate},
    inpaint::{decode_removals, removal_to_json},
    Removal,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

pub const SAVED_REMOVAL_EDIT_VERSION: u32 = 1;
pub const SAVED_REMOVAL_ENTRY_FIELDS: &[(&str, &str)] = &[
    ("id", "string"),
    ("index", "number"),
    ("active", "boolean"),
    ("editable", "boolean"),
    ("needs_review", "boolean"),
    ("region", "number[]"),
    ("model_version", "string"),
    ("mask", "string | null"),
];

#[derive(Serialize)]
pub struct SavedRemovalEntry {
    pub id: String,
    pub index: usize,
    pub active: bool,
    pub editable: bool,
    pub needs_review: bool,
    pub region: [f32; 4],
    pub model_version: String,
    pub mask: Option<String>,
}

struct Row {
    index: usize,
    id: ContentDigest,
    removal: Removal,
}

struct Stack {
    values: Vec<Value>,
    rows: Vec<Row>,
}

impl Stack {
    fn read(records: &str) -> Result<Self, String> {
        let known = decode_removals(records)?;
        let values: Vec<Value> = serde_json::from_str(records).map_err(|e| e.to_string())?;
        let mut removals = known.into_iter();
        let mut identities = BTreeSet::new();
        let mut rows = Vec::new();
        for (index, value) in values.iter().enumerate() {
            if value.get("kind").and_then(Value::as_str) != Some("removal") {
                continue;
            }
            let removal = removals
                .next()
                .ok_or("removal list changed during validation")?;
            let id = if let Some(operation) = &removal.operation {
                operation.id.clone()
            } else {
                let record = super::removal_record_digest(&removal)?;
                let mut identity = b"maple-removal-operation-v1\0".to_vec();
                identity.extend_from_slice(record.as_str().as_bytes());
                identity.extend_from_slice(&(index as u64).to_le_bytes());
                ContentDigest::for_bytes(&identity)
            };
            if !identities.insert(id.as_str().to_owned()) {
                return Err("removal stack has duplicate operation identities".into());
            }
            rows.push(Row { index, id, removal });
        }
        Ok(Self { values, rows })
    }

    fn selected(&self, id: &str) -> Result<&Row, String> {
        ContentDigest::parse(id)?;
        self.rows
            .iter()
            .find(|row| row.id.as_str() == id)
            .ok_or_else(|| "The saved removal changed. Reopen the photo before editing it.".into())
    }

    fn editable(removal: &Removal) -> bool {
        removal
            .accepted
            .as_ref()
            .is_some_and(|accepted| accepted.plate == RemovalPlate::LinearCalibrationV1)
    }

    fn upgrade(&self) -> Vec<Value> {
        let mut values = self.values.clone();
        // Assign every supported identity before changing list order. Read-only
        // listing leaves schema-2/3/4 bytes untouched; unrelated kinds survive.
        for row in &self.rows {
            if Self::editable(&row.removal) && row.removal.operation.is_none() {
                let upgraded = Removal {
                    operation: Some(RemovalOperation {
                        id: row.id.clone(),
                        active: true,
                    }),
                    ..row.removal.clone()
                };
                values[row.index] = removal_to_json(&upgraded);
            }
        }
        values
    }
}

pub fn saved_removal_list(records: &str) -> Result<String, String> {
    let stack = Stack::read(records)?;
    let mut prior = Vec::new();
    let mut entries = Vec::new();
    for row in stack.rows {
        entries.push(SavedRemovalEntry {
            id: row.id.as_str().into(),
            index: row.index,
            active: row.removal.is_active(),
            editable: Stack::editable(&row.removal),
            needs_review: super::removal_needs_review(&row.removal, &prior)?,
            region: row.removal.region,
            model_version: row.removal.model_version.clone(),
            mask: row
                .removal
                .accepted
                .as_ref()
                .map(|accepted| accepted.mask.as_str().into()),
        });
        prior.push(row.removal);
    }
    serde_json::to_string(&entries).map_err(|e| e.to_string())
}

/// The generation input for replacing one operation: only preceding records.
/// Later accepted pixels are never included in this reconstruction context.
pub fn saved_removal_prefix(records: &str, id: &str) -> Result<String, String> {
    let stack = Stack::read(records)?;
    let row = stack.selected(id)?;
    if !Stack::editable(&row.removal) {
        return Err(
            "This legacy removal cannot be regenerated by the current authoring flow.".into(),
        );
    }
    serde_json::to_string(&stack.values[..row.index]).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditRequest {
    schema: u32,
    id: ContentDigest,
    action: SavedRemovalAction,
    active: Option<bool>,
    /// A prepared preceding-prefix + one new accepted record, not pixel bytes.
    replacement: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SavedRemovalAction {
    SetActive,
    Delete,
    Replace,
}

impl SavedRemovalAction {
    pub const ALL: [Self; 3] = [Self::SetActive, Self::Delete, Self::Replace];
}

pub fn edit_saved_removal(records: &str, request: &str) -> Result<String, String> {
    let request: EditRequest = serde_json::from_str(request).map_err(|e| e.to_string())?;
    if request.schema != SAVED_REMOVAL_EDIT_VERSION {
        return Err("unsupported saved removal edit request".into());
    }
    let stack = Stack::read(records)?;
    let row = stack.selected(request.id.as_str())?;
    let mut values = stack.upgrade();
    match request.action {
        SavedRemovalAction::Delete => {
            if request.active.is_some() || request.replacement.is_some() {
                return Err("deletion cannot contain replacement or enable state".into());
            }
            values.remove(row.index);
        }
        SavedRemovalAction::SetActive => {
            if !Stack::editable(&row.removal) || request.replacement.is_some() {
                return Err("enable state requires a supported accepted removal".into());
            }
            values[row.index]["active"] = request.active.ok_or("missing enable state")?.into();
        }
        SavedRemovalAction::Replace => {
            if !Stack::editable(&row.removal) || request.active.is_some() {
                return Err("replacement requires a supported accepted removal".into());
            }
            let candidate = Stack::read(
                request
                    .replacement
                    .as_deref()
                    .ok_or("missing replacement")?,
            )?;
            if candidate.values.len() != row.index + 1
                || candidate.values[..row.index] != stack.values[..row.index]
            {
                return Err("replacement generation context changed".into());
            }
            let replacement = candidate.rows.last().ok_or("missing replacement record")?;
            if replacement.index != row.index
                || !Stack::editable(&replacement.removal)
                || replacement.removal.accepted.as_ref().map(|a| &a.source)
                    != row.removal.accepted.as_ref().map(|a| &a.source)
            {
                return Err("replacement source or calibration anchor changed".into());
            }
            let prior: Vec<Removal> = candidate.rows[..candidate.rows.len() - 1]
                .iter()
                .map(|row| row.removal.clone())
                .collect();
            if super::removal_needs_review(&replacement.removal, &prior)? {
                return Err("replacement has an incorrect generation dependency snapshot".into());
            }
            let accepted = Removal {
                operation: Some(RemovalOperation {
                    id: row.id.clone(),
                    active: true,
                }),
                ..replacement.removal.clone()
            };
            values[row.index] = removal_to_json(&accepted);
        }
    }
    let result = serde_json::to_string(&values).map_err(|e| e.to_string())?;
    Stack::read(&result)?;
    Ok(result)
}

#[cfg(test)]
#[path = "removal_edit_tests.rs"]
mod tests;

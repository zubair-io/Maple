//! Shared sidecar workflow records (#4035, storage stage of #2437).
//!
//! These are persisted authoring records, never render-loop inputs. A checkpoint
//! stores complete adjustment XMP, including authored WB and foreign edit data;
//! a second hand-copied development schema cannot silently lose new fields.
//! Host sibling discovery/create/delete, variant switching and UI remain tracked
//! by #2437. This module alone does not release that workflow.

use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;
mod validation;
mod variants;
pub use variants::variant_filename;
mod xml;
#[cfg(test)]
mod xml_tests;
mod xml_tree;

pub const WORKFLOW_VERSION: u32 = 1;
/// Cheap host dispatch guard only; Rust still resolves/validates the namespace.
pub const WORKFLOW_MARKUP_PATTERN: &str = r"<(?:[^<\s:]+:)?Workflow(?=[\s/>])";
/// Matches the existing 32-commit Apple/Web undo window.
pub const HISTORY_LIMIT: usize = 32;
/// Matches the existing backup-sidecar ingress bound; embedding also checks
/// the final XML size at the host's confirmed-write boundary (#2437).
pub const WORKFLOW_MAX_BYTES: usize = 256 * 1024;
pub const PRIMARY_VARIANT_ID: &str = "primary";
pub const MAX_TIMESTAMP_MS: u64 = 9_007_199_254_740_991;
pub const WORKFLOW_ACTIONS: &[&str] = &[
    "adjustment",
    "preset",
    "paste",
    "reset",
    "snapshot-restore",
    "history-restore",
    "undo",
    "redo",
    "variant-create",
];

#[derive(Clone, Copy)]
pub enum WireKind {
    Text,
    U32,
    U64,
    List(&'static str),
}
pub struct WorkflowField {
    pub name: &'static str,
    pub kind: WireKind,
}
pub struct WorkflowRecord {
    pub name: &'static str,
    pub fields: &'static [WorkflowField],
}

macro_rules! workflow_record {
    ($name:ident, $fields:ident { $( $field:ident : $ty:ty => $wire:literal, $kind:expr; )* }) => {
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct $name {
            $( #[serde(rename = $wire)] pub $field: $ty, )*
        }
        pub const $fields: &[WorkflowField] = &[
            $( WorkflowField { name: $wire, kind: $kind }, )*
        ];
    };
}

workflow_record! { WorkflowSnapshot, SNAPSHOT_FIELDS {
    id: String => "id", WireKind::Text;
    name: String => "name", WireKind::Text;
    created_at_ms: u64 => "createdAtMs", WireKind::U64;
    adjustment_xmp: String => "adjustmentXmp", WireKind::Text;
}}
workflow_record! { WorkflowHistoryEntry, HISTORY_FIELDS {
    id: String => "id", WireKind::Text;
    created_at_ms: u64 => "createdAtMs", WireKind::U64;
    action: String => "action", WireKind::Text;
    label: String => "label", WireKind::Text;
    adjustment_xmp: String => "adjustmentXmp", WireKind::Text;
}}
workflow_record! { SidecarWorkflow, WORKFLOW_FIELDS {
    schema_version: u32 => "schemaVersion", WireKind::U32;
    variant_id: String => "variantId", WireKind::Text;
    variant_name: String => "variantName", WireKind::Text;
    snapshots: Vec<WorkflowSnapshot> => "snapshots", WireKind::List("WorkflowSnapshot");
    history: Vec<WorkflowHistoryEntry> => "history", WireKind::List("WorkflowHistoryEntry");
}}

pub const WORKFLOW_RECORDS: &[WorkflowRecord] = &[
    WorkflowRecord {
        name: "WorkflowSnapshot",
        fields: SNAPSHOT_FIELDS,
    },
    WorkflowRecord {
        name: "WorkflowHistoryEntry",
        fields: HISTORY_FIELDS,
    },
    WorkflowRecord {
        name: "SidecarWorkflow",
        fields: WORKFLOW_FIELDS,
    },
];

impl SidecarWorkflow {
    pub fn primary() -> Self {
        Self {
            schema_version: WORKFLOW_VERSION,
            variant_id: PRIMARY_VARIANT_ID.into(),
            variant_name: "Original".into(),
            snapshots: Vec::new(),
            history: Vec::new(),
        }
    }

    pub fn parse(json: &str) -> Result<Self, String> {
        validation::size(json)?;
        let value: Self = serde_json::from_str(json).map_err(|e| e.to_string())?;
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), String> {
        self.to_json().map(|_| ())
    }

    pub fn to_json(&self) -> Result<String, String> {
        validation::workflow(self)?;
        let json = serde_json::to_string(self).map_err(|e| e.to_string())?;
        validation::size(&json)?;
        Ok(json)
    }

    /// A committed semantic action has an immutable full checkpoint. Compact
    /// only the oldest history entries; retained states never depend on a
    /// discarded delta. Named snapshots are independent and are not compacted.
    /// Called at commit/save, never for intermediate slider or render ticks.
    pub fn committed(&self, entry: WorkflowHistoryEntry) -> Result<Self, String> {
        self.validate()?;
        validation::history_entry(&entry)?;
        if self.history.iter().any(|old| old.id == entry.id) {
            return Err("duplicate history identity".into());
        }
        let keep_from = self.history.len().saturating_sub(HISTORY_LIMIT - 1);
        let history = self.history[keep_from..]
            .iter()
            .cloned()
            .chain([entry])
            .collect();
        let next = Self {
            history,
            ..self.clone()
        };
        // A large authored mask can fill the byte budget before the count
        // window. Retire oldest independent checkpoints until the newest
        // commit fits, preserving every retained byte and all named snapshots.
        for drop_count in 0..next.history.len() {
            let compacted = Self {
                history: next.history[drop_count..].to_vec(),
                ..next.clone()
            };
            if compacted.to_json().is_ok() {
                return Ok(compacted);
            }
        }
        Err("new checkpoint and named snapshots exceed workflow byte budget".into())
    }

    pub fn with_snapshot(&self, snapshot: WorkflowSnapshot) -> Result<Self, String> {
        self.validate()?;
        validation::snapshot(&snapshot)?;
        if self.snapshots.iter().any(|old| old.id == snapshot.id) {
            return Err("duplicate snapshot identity".into());
        }
        let snapshots = self.snapshots.iter().cloned().chain([snapshot]).collect();
        let next = Self {
            snapshots,
            ..self.clone()
        };
        next.to_json()?;
        Ok(next)
    }
}

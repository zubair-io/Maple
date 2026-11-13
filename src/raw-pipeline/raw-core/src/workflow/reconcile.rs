//! Compare-and-swap reconciliation of a stale writer (#4983).
//!
//! A writer names the document it was based on (`base`). When the file is no
//! longer that document, the writer's change is applied on top of the current
//! one instead of being refused, and the displaced state stays recoverable in
//! the history rather than being overwritten unrecorded.
use super::{
    merge, validation, SidecarWorkflow, WorkflowHistoryEntry, EXTERNAL_ACTION, MAX_TIMESTAMP_MS,
};

impl SidecarWorkflow {
    /// `base` is the last document the writer read or published (`""` when it
    /// saw no sidecar), `current` what the file holds now, and `incoming` the
    /// complete document the writer wants to publish. All carry their
    /// Workflow record; only `current`'s is used. `now_ms` stamps an external
    /// capture. Returns the document to publish: the merged adjustments with
    /// `current`'s record, plus an `external` entry when `current` was not yet
    /// the history head.
    ///
    /// The writer then commits its own entry on the result with
    /// `parentId` set to the head it was based on.
    pub fn reconcile_xmp(
        base: &str,
        current: &str,
        incoming: &str,
        now_ms: u64,
    ) -> Result<String, String> {
        if now_ms > MAX_TIMESTAMP_MS {
            return Err("workflow timestamp exceeds JSON integer precision".into());
        }
        let record = Self::from_xmp(current)?;
        let current_checkpoint = Self::checkpoint_xmp(current)?;
        let incoming_checkpoint = Self::checkpoint_xmp(incoming)?;
        let base_checkpoint = (!base.is_empty())
            .then(|| Self::checkpoint_xmp(base))
            .transpose()?;
        if merge::same_properties(base_checkpoint.as_deref(), &current_checkpoint)? {
            // Nothing changed since the writer read the file.
            return Self::keep_record(record, &incoming_checkpoint);
        }
        let merged = merge::three_way(
            base_checkpoint.as_deref(),
            &current_checkpoint,
            &incoming_checkpoint,
        )?;
        let record = record.unwrap_or_else(Self::primary);
        let recorded = match record.history.last() {
            Some(head) => Self::matches_checkpoint(&head.adjustment_xmp, &current_checkpoint)?,
            None => false,
        };
        let record = if recorded {
            record
        } else {
            record.with_external(current_checkpoint, now_ms)?
        };
        record.embed_compacted(&merged)
    }

    fn keep_record(record: Option<Self>, checkpoint: &str) -> Result<String, String> {
        match record {
            Some(record) => record.embed_compacted(checkpoint),
            None => {
                validation::checkpoint(checkpoint)?;
                Ok(checkpoint.to_owned())
            }
        }
    }

    /// Record a state no history-keeping writer produced. The id derives from
    /// the content and its parent, so two writers capturing the same change
    /// record one entry.
    fn with_external(self, checkpoint: String, now_ms: u64) -> Result<Self, String> {
        let parent_id = self.head_id().to_owned();
        let id = external_id(&parent_id, &checkpoint);
        if self.history.iter().any(|entry| entry.id == id) {
            return Ok(self);
        }
        self.committed(WorkflowHistoryEntry {
            id,
            created_at_ms: now_ms,
            action: EXTERNAL_ACTION.into(),
            label: "Changed outside Maple".into(),
            parent_id,
            writer: String::new(),
            adjustment_xmp: checkpoint,
        })
    }
}

/// A UUID derived from `parent` and `checkpoint` (BLAKE3, version/variant
/// bits set), canonical lowercase so it passes identity validation.
fn external_id(parent: &str, checkpoint: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(parent.as_bytes());
    hasher.update(&[0]);
    hasher.update(checkpoint.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hasher.finalize().as_bytes()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

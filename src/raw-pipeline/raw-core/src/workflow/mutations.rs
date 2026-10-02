//! Complete-XMP authoring operations at semantic save boundaries (#4042).
use super::{validation, SidecarWorkflow, WorkflowHistoryEntry, WorkflowSnapshot};

impl SidecarWorkflow {
    /// Commit exactly the current complete checkpoint, never a renderer event
    /// or stale model supplied by a host. Compaction includes final XML escaping.
    pub fn commit_xmp(xmp: &str, entry_json: &str) -> Result<String, String> {
        validation::size(entry_json)?;
        let entry: WorkflowHistoryEntry =
            serde_json::from_str(entry_json).map_err(|e| e.to_string())?;
        if matches!(
            entry.action.as_str(),
            "snapshot-restore" | "history-restore"
        ) {
            return Err("restore actions must select a persisted checkpoint".into());
        }
        let current = Self::checkpoint_xmp(xmp)?;
        if !Self::matches_checkpoint(&entry.adjustment_xmp, &current)? {
            return Err("committed checkpoint does not match current XMP".into());
        }
        let record = Self::from_xmp(xmp)?.unwrap_or_else(Self::primary);
        record.committed(entry)?.embed_compacted(xmp)
    }

    /// Named snapshots are immutable complete checkpoints. Adding one never
    /// silently discards another snapshot or a retained history state.
    pub fn snapshot_xmp(xmp: &str, snapshot_json: &str) -> Result<String, String> {
        validation::size(snapshot_json)?;
        let snapshot: WorkflowSnapshot =
            serde_json::from_str(snapshot_json).map_err(|e| e.to_string())?;
        if !Self::matches_checkpoint(&snapshot.adjustment_xmp, &Self::checkpoint_xmp(xmp)?)? {
            return Err("snapshot checkpoint does not match current XMP".into());
        }
        let record = Self::from_xmp(xmp)?.unwrap_or_else(Self::primary);
        record.with_snapshot(snapshot)?.embed_in_xmp(xmp)
    }

    /// Restore an exact persisted snapshot/history checkpoint, retaining current
    /// variant identity and all named snapshots. The restore is one new semantic
    /// entry; host transactions supply the one-step Undo boundary (#2437).
    pub fn restore_xmp(xmp: &str, entry_json: &str) -> Result<String, String> {
        validation::size(entry_json)?;
        let entry: WorkflowHistoryEntry =
            serde_json::from_str(entry_json).map_err(|e| e.to_string())?;
        let record = Self::from_xmp(xmp)?.ok_or("no persisted workflow to restore")?;
        let exists = match entry.action.as_str() {
            "snapshot-restore" => record
                .snapshots
                .iter()
                .any(|old| old.adjustment_xmp == entry.adjustment_xmp),
            "history-restore" => record
                .history
                .iter()
                .any(|old| old.adjustment_xmp == entry.adjustment_xmp),
            _ => return Err("restore requires snapshot-restore or history-restore action".into()),
        };
        if !exists {
            return Err("restore checkpoint is not present in the selected variant".into());
        }
        let checkpoint = entry.adjustment_xmp.clone();
        record.committed(entry)?.embed_compacted(&checkpoint)
    }

    fn matches_checkpoint(captured: &str, current: &str) -> Result<bool, String> {
        if captured == current {
            return Ok(true);
        }
        validation::checkpoint(captured)?;
        // A host may attach the retained record before committing (#4052).
        // Only our own necessary self-closing Description expansion is allowed;
        // no adjustment, foreign byte, or whitespace normalization is performed.
        // The captured checkpoint remains exact in history and snapshots.
        let embedded = Self::primary().embed_in_xmp(captured)?;
        Ok(Self::checkpoint_xmp(&embedded)? == current)
    }

    fn embed_compacted(&self, xmp: &str) -> Result<String, String> {
        // Both the record's JSON and the outer XML must fit. Escaped authored
        // masks may hit the XML bound first; retain the newest independent
        // checkpoint and all snapshots, dropping only oldest history entries.
        self.embed_in_xmp(xmp).or_else(|error| {
            if self.history.len() <= 1 {
                return Err(format!(
                    "new checkpoint and named snapshots cannot fit: {error}"
                ));
            }
            Self {
                history: self.history[1..].to_vec(),
                ..self.clone()
            }
            .embed_compacted(xmp)
        })
    }
}

//! Undo/redo stacks derived from the persisted history (#4983).
//!
//! The history is an append-only log of complete states, so the editor's undo
//! and redo stacks are a fold over it. Every host rebuilds the same ring after
//! a restart from this one function, up to the history cap.
use super::SidecarWorkflow;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HistoryCursor {
    /// Ids of the entries holding the states undo steps back to, oldest first;
    /// the last one is the next undo.
    pub undo: Vec<String>,
    /// Ids of the entries holding the states redo steps forward to, nearest
    /// (the next redo) first.
    pub redo: Vec<String>,
    /// Whether the sidecar still equals the history head. When it does not
    /// (an external edit, a crash after an ordinary save), the head becomes the
    /// next undo step and redo is empty.
    pub synced: bool,
}

impl SidecarWorkflow {
    /// `current_checkpoint` is the sidecar's complete document without its
    /// Workflow record.
    pub fn cursor(&self, current_checkpoint: &str) -> Result<HistoryCursor, String> {
        let mut undo: Vec<usize> = Vec::new();
        let mut redo: Vec<usize> = Vec::new();
        let mut head = 0;
        for (index, entry) in self.history.iter().enumerate().skip(1) {
            match entry.action.as_str() {
                "undo" => {
                    // The first edit has no earlier retained state, so undoing
                    // it leaves the undo stack empty.
                    undo.pop();
                    redo.push(head);
                }
                "redo" if !redo.is_empty() => {
                    redo.pop();
                    undo.push(head);
                }
                _ => {
                    undo.push(head);
                    redo.clear();
                }
            }
            head = index;
        }
        let synced = match self.history.last() {
            Some(last) => Self::matches_checkpoint(&last.adjustment_xmp, current_checkpoint)?,
            None => true,
        };
        if !synced {
            undo.push(head);
            redo.clear();
        }
        let ids = |indices: &[usize]| {
            indices
                .iter()
                .map(|&index| self.history[index].id.clone())
                .collect::<Vec<_>>()
        };
        Ok(HistoryCursor {
            undo: ids(&undo),
            redo: ids(&redo.into_iter().rev().collect::<Vec<_>>()),
            synced,
        })
    }

    /// The cursor of a complete sidecar as JSON; an absent record has no history.
    pub fn cursor_xmp(xmp: &str) -> Result<String, String> {
        let cursor = match Self::from_xmp(xmp)? {
            Some(record) => record.cursor(&Self::checkpoint_xmp(xmp)?)?,
            None => HistoryCursor {
                undo: Vec::new(),
                redo: Vec::new(),
                synced: true,
            },
        };
        serde_json::to_string(&cursor).map_err(|e| e.to_string())
    }
}

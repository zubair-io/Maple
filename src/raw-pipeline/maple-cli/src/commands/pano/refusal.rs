//! A stitch refused for lack of memory or scratch space (#5835). That is an
//! answer rather than a fault, so the report says what the run needed and
//! what there was, and the caller can tell the user instead of pointing at a
//! log.

use std::path::Path;

use maple_pano::stitch::StitchError;
use serde_json::{json, Value};

fn refused(e: &StitchError) -> Option<Value> {
    match e {
        StitchError::InsufficientMemory { needed, limit } => Some(json!({
            "reason": "memory",
            "needed_bytes": needed,
            "available_bytes": limit,
        })),
        StitchError::InsufficientScratchSpace {
            needed, available, ..
        } => Some(json!({
            "reason": "scratch_space",
            "needed_bytes": needed,
            "available_bytes": available,
        })),
        _ => None,
    }
}

/// The error text for `e`. A refusal is first written to `report`.
pub(super) fn describe(e: StitchError, report: Option<&Path>) -> String {
    if let (Some(block), Some(path)) = (refused(&e), report) {
        let pretty =
            serde_json::to_string_pretty(&json!({ "refused": block })).expect("report serializes");
        if let Err(io) = std::fs::write(path, pretty) {
            eprintln!("pano: {}: {io}", path.display());
        }
    }
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report_in(dir: &Path, e: StitchError) -> Option<Value> {
        let path = dir.join("report.json");
        describe(e, Some(&path));
        std::fs::read(&path)
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).expect("report is JSON"))
    }

    #[test]
    fn a_memory_refusal_is_reported_with_what_it_needed_and_the_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let report = report_in(
            dir.path(),
            StitchError::InsufficientMemory {
                needed: 3_000,
                limit: 2_000,
            },
        );
        assert_eq!(
            report,
            Some(json!({ "refused": {
                "reason": "memory", "needed_bytes": 3_000, "available_bytes": 2_000,
            }}))
        );
    }

    #[test]
    fn a_scratch_refusal_is_reported_with_what_it_needed_and_the_free_space() {
        let dir = tempfile::tempdir().expect("tempdir");
        let report = report_in(
            dir.path(),
            StitchError::InsufficientScratchSpace {
                path: dir.path().to_path_buf(),
                needed: 9_000,
                available: 100,
            },
        );
        assert_eq!(
            report,
            Some(json!({ "refused": {
                "reason": "scratch_space", "needed_bytes": 9_000, "available_bytes": 100,
            }}))
        );
    }

    #[test]
    fn any_other_failure_writes_no_report() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(report_in(dir.path(), StitchError::TooFewFrames(1)), None);
    }

    #[test]
    fn the_error_text_is_the_stitch_error_with_or_without_a_report_path() {
        let text = describe(
            StitchError::InsufficientMemory {
                needed: 3_000,
                limit: 2_000,
            },
            None,
        );
        assert!(text.contains("3000 bytes") && text.contains("2000 byte limit"));
    }
}

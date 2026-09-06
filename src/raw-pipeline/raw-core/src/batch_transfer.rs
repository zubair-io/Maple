//! Progress and recovery contract shared by the three #3311 batch runners.
//! Identifiers remain platform-native opaque strings; the fields and outcome
//! vocabulary are generated for Apple and Web (also consumed by Self Hosted).

pub const BATCH_TRANSFER_STATUSES: &[&str] = &["ready", "running", "cancelled", "complete"];
pub const BATCH_ASSET_STATUSES: &[&str] = &["pending", "prepared", "applied", "failed"];

/// Canonical wire shape. The small table is consumed by the existing codegen
/// so UI counters and persisted recovery summaries cannot drift by platform.
pub const BATCH_TRANSFER_DTOS: &[(&str, &[(&str, &str)])] = &[
    (
        "BatchTransferFailure",
        &[("id", "string"), ("reason", "string")],
    ),
    (
        "BatchTransferProgress",
        &[
            ("total", "number"),
            ("processed", "number"),
            ("applied", "number"),
            ("failed", "number"),
            ("current", "string"),
            ("outcome", "BatchAssetStatus"),
        ],
    ),
    (
        "BatchTransferSummary",
        &[
            ("applied", "string[]"),
            ("failed", "BatchTransferFailure[]"),
            ("cancelled", "boolean"),
        ],
    ),
];

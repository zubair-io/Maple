//! Per-subcommand handlers for `maple-cli`.
//!
//! `main.rs` keeps the clap scaffolding (the `Cli` / `Cmd` derives) and
//! dispatches each variant to `commands::<name>::run(...)`. Per the ticket
//! that introduced this split (#525), each command's body owns its imports
//! and helpers — only the value enums shared with the `Cmd` derive live in
//! [`types`]. Same hygiene refactor pattern as #472 applied to
//! `auto_exposure.rs`.

pub mod auto_adjustments;
pub mod auto_tone;
pub mod batch;
pub mod diff;
pub mod extract_preview;
pub mod inspect;
pub mod render;
pub mod synthetic;
pub mod tile;
pub mod transcode_dcp;
pub mod types;

#[cfg(feature = "pano")]
pub mod pano;

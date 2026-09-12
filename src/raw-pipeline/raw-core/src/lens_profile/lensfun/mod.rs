//! Bundled Lensfun lens corrections (#3564): the open (CC BY-SA 3.0)
//! calibration database, converted into raw-core's focal-normalised frame
//! at build time by `src/scripts/convert_lensfun_db.py`, so distortion,
//! lateral CA and vignetting apply automatically for every matched lens on
//! every platform. `ATTRIBUTION.md` next to `db.bin` carries the licence
//! and the source commit. See
//! `docs/superpowers/specs/2026-09-12-lensfun-bundled-lens-corrections-design.md`.

pub mod bundle;
pub mod calibration;
pub mod matcher;
pub mod names;
pub mod resolve;

pub use bundle::{Camera, Database, DatabaseVersion, Lens, Mount};
pub use calibration::{chromatic, distortion, frame, vignette};
pub use matcher::{by_slug, compatible, find, slug, Match};
pub use names::{canonical, canonical_camera};

use std::sync::OnceLock;

/// The converted Lensfun table, included at compile time so every host
/// (xcframework, Windows DLL, API dylib, wasm) carries the same snapshot.
static BUNDLE: &[u8] = include_bytes!("db.bin");
static DATABASE: OnceLock<Database> = OnceLock::new();

/// The bundled database. A malformed bundle is a build defect, not a
/// runtime condition, so the one-time parse panics with the reader's
/// offset rather than returning an error every caller would have to thread.
pub fn database() -> &'static Database {
    DATABASE.get_or_init(|| bundle::parse(BUNDLE).expect("bundled Lensfun table is well-formed"))
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests_auto;
#[cfg(test)]
mod tests_bundle;
#[cfg(test)]
mod tests_database;
#[cfg(test)]
mod tests_matcher;
#[cfg(test)]
mod tests_parity;
#[cfg(test)]
mod tests_resolve;

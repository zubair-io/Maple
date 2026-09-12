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

pub use bundle::{Camera, Database, DatabaseVersion, Lens, Mount};
pub use calibration::{chromatic, distortion, frame, vignette};
pub use matcher::{by_slug, compatible, find, slug, Match};
pub use names::{canonical, canonical_camera};

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests_bundle;
#[cfg(test)]
mod tests_matcher;

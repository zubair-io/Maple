//! The registry's declarations, checked against real decodes (#2440).
//!
//! [`FIXTURED_BODIES`] states four things about each physical fixture: its
//! lookup key, which resolver branch it takes, whether it carries lens
//! corrections, and whether it decodes at all. Every one of those is a
//! fact about the file, so none of them is allowed to be an opinion — this
//! module opens each fixture and checks.
//!
//! Fixture-gated in the usual way (`test-fixtures/raws/` is gitignored):
//! absent fixtures skip-pass with a message rather than failing, matching
//! the convention in `docs/testing.md`. The gate that CI *does* enforce is
//! `codegen-drift`: a declaration that stops matching reality changes the
//! generated registry, and the drift job fails until it is committed.

use std::path::PathBuf;

use super::*;
use crate::color::dcp::profile_for_with_source;

fn fixture_root() -> Option<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws")
        .canonicalize()
        .ok()?;
    root.is_dir().then_some(root)
}

/// Every declared fixture exists, decodes as declared, keys as declared,
/// resolves to the declared profile branch, and carries the declared lens
/// data. One test rather than sixteen so a missing corpus skips once.
#[test]
fn declarations_match_the_fixtures_on_disk() {
    let Some(root) = fixture_root() else {
        eprintln!("support_tiers: no test-fixtures/raws — skipping");
        return;
    };
    let mut checked = 0usize;
    let mut mismatches: Vec<String> = Vec::new();
    for body in FIXTURED_BODIES {
        let path = root.join(body.fixture);
        if !path.exists() {
            eprintln!("support_tiers: {} absent — skipping", body.fixture);
            continue;
        }
        checked += 1;
        let decoded = match crate::decode::decode(&path) {
            Ok(raw) => raw,
            Err(e) => {
                if body.resolution != ProfileResolution::DecodeFailed {
                    mismatches.push(format!(
                        "{}: declared {:?} but decode failed: {e}",
                        body.fixture, body.resolution
                    ));
                }
                continue;
            }
        };
        if body.resolution == ProfileResolution::DecodeFailed {
            mismatches.push(format!(
                "{}: declared decode_failed but it decoded",
                body.fixture
            ));
            continue;
        }
        let key = crate::color::profile_loader::camera_key_for(&decoded).unique_camera_model;
        if key != body.key {
            mismatches.push(format!(
                "{}: declared key `{}`, decoded key `{key}`",
                body.fixture, body.key
            ));
        }
        match profile_for_with_source(&decoded) {
            Ok((_, source)) => {
                let observed = ProfileResolution::from(&source);
                if observed != body.resolution {
                    mismatches.push(format!(
                        "{}: declared {:?}, resolver found {observed:?}",
                        body.fixture, body.resolution
                    ));
                }
            }
            Err(e) => mismatches.push(format!("{}: profile resolution failed: {e}", body.fixture)),
        }
        let observed_lens = if decoded.has_lens_corrections() {
            LensSupport::EmbeddedCorrection
        } else {
            LensSupport::NoCorrectionData
        };
        if observed_lens != body.lens {
            mismatches.push(format!(
                "{}: declared lens {:?}, file has {observed_lens:?}",
                body.fixture, body.lens
            ));
        }
    }
    if checked == 0 {
        eprintln!("support_tiers: no fixtures present — skipping");
        return;
    }
    assert!(
        mismatches.is_empty(),
        "the registry disagrees with the fixtures ({checked} checked):\n  {}",
        mismatches.join("\n  ")
    );
}

/// The `Qualified` candidate set is exactly the camera bodies Maple holds
/// a file for: a camera fixture in `test-fixtures/raws/` that no entry
/// claims is a body silently missing from the registry.
///
/// Two kinds of fixture are deliberately unclaimed, and both are named
/// here rather than filtered by a pattern, so adding a real camera fixture
/// cannot slip through as "probably synthetic".
#[test]
fn no_camera_fixture_is_missing_from_the_registry() {
    /// Files under `test-fixtures/raws/` that are not a distinct camera
    /// body, with the reason each one is not:
    ///
    /// - `test_0007` / `test_0010` — second files from bodies the registry
    ///   already carries (`test_0006`'s 5D Mark III, `test_0009`'s 5D Mark
    ///   IV). The registry keys on the body, not the file.
    /// - `test_0018` / `test_0019` / `test_0020` — synthetic charts Maple
    ///   generates itself (`Maple Synthetic Chart` and friends). They are
    ///   colour-pipeline instruments, not cameras, and tiering them would
    ///   claim support for a body nobody owns.
    const NON_BODY_FIXTURES: &[&str] = &[
        "test_0007.DNG",
        "test_0010.CR2",
        "test_0018.dng",
        "test_0019.dng",
        "test_0020.dng",
    ];
    /// Extensions that are a RAW file rather than a sidecar, spec or
    /// stray backup sitting next to one.
    const RAW_EXTENSIONS: &[&str] = &["dng", "cr2", "raf", "arw", "nef", "raw", "fff", "x3f"];
    let Some(root) = fixture_root() else {
        eprintln!("support_tiers: no test-fixtures/raws — skipping");
        return;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        eprintln!("support_tiers: cannot read the fixture dir — skipping");
        return;
    };
    let unclaimed: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("test_"))
        .filter(|name| {
            std::path::Path::new(name)
                .extension()
                .map(|e| RAW_EXTENSIONS.contains(&e.to_string_lossy().to_lowercase().as_str()))
                .unwrap_or(false)
        })
        .filter(|name| {
            !NON_BODY_FIXTURES.contains(&name.as_str())
                && !FIXTURED_BODIES.iter().any(|b| b.fixture == *name)
        })
        .collect();
    assert!(
        unclaimed.is_empty(),
        "camera fixtures with no registry entry: {unclaimed:?}"
    );
}

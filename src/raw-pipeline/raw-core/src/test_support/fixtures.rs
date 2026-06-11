//! Fixture resolution for tests gated on the gitignored `test-fixtures/`
//! tree (repo root). Pairs with the `fixtures` cargo feature (#1082):
//!
//! ```text
//! #[test]
//! #[cfg_attr(not(feature = "fixtures"), ignore)]
//! fn decode_test_0002() {
//!     let path = crate::test_support::fixtures::require_raw("test_0002.dng");
//!     …
//! }
//! ```
//!
//! * WITHOUT `--features fixtures` the test is *visibly* ignored — it shows
//!   up in the `… ignored` count instead of silently passing.
//! * WITH `--features fixtures` (a fixture-provisioned machine opting in) a
//!   missing fixture PANICS — broken provisioning fails closed instead of
//!   green-no-opping.
//!
//! This replaces the repo's historical `if !path.exists() { return; }`
//! pattern, which passed silently in both worlds.

use std::path::PathBuf;

/// Repo-root `test-fixtures/raws/` directory (gitignored RAWs).
pub fn raws_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws")
}

/// Repo-root `test-fixtures/references/` directory (gitignored ACR refs + XMPs).
pub fn references_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/references")
}

/// Resolve `test-fixtures/raws/<name>`, panicking when absent.
pub fn require_raw(name: &str) -> PathBuf {
    require(raws_root().join(name))
}

/// Resolve `test-fixtures/references/<rel>`, panicking when absent.
pub fn require_reference(rel: &str) -> PathBuf {
    require(references_root().join(rel))
}

/// Assert a fixture path exists and hand it back.
///
/// Callers must be `#[cfg_attr(not(feature = "fixtures"), ignore)]` so this
/// panic only fires when fixtures were explicitly requested (or when an
/// ignored test is forced via `--include-ignored`, which carries the same
/// "actually run it" intent).
pub fn require(path: PathBuf) -> PathBuf {
    assert!(
        path.exists(),
        "missing fixture: {} — the gitignored test-fixtures/ tree is absent or \
         incomplete on this machine. Provision it (or symlink the main checkout's \
         test-fixtures/) to run with --features fixtures; without the feature \
         these tests are skipped as `ignored`.",
        path.display()
    );
    path
}

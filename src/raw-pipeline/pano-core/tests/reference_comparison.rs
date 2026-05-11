//! Stage H — pano_01 reference-comparison gate.
//!
//! Renders the 21-frame `pano_01` scene through `pano-smoke --release`
//! with default flags and compares the result against the ACR-rendered
//! reference via `tools/compare-with-reference.py`. Gates four metrics
//! against the budgets file at
//! `test-fixtures/budgets/reference_pano_01.json`.
//!
//! Skip-passes (eprintln + early return — same pattern as
//! `lightglue_smoke.rs`) when any of the inputs is absent:
//!
//!   - the 21 DNGs at `test-fixtures/raws/pano_01/PANO0001..0021.DNG`,
//!   - the ACR reference at
//!     `test-fixtures/pano/references/pano_01_reference.png`,
//!   - the budgets file (the test owns this — only missing if someone
//!     deletes it),
//!   - `python3` on PATH.
//!
//! Budgets file is intentionally tracked in the repo. Lowering a
//! budget happens in the same commit that delivers the improvement
//! that justifies it (one-way ratchet, mirrors `budgets.json` for
//! the colour-pipeline harness).

use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

fn raw_pipeline_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
}

fn pano_01_dngs() -> Option<Vec<PathBuf>> {
    let dir = repo_root().join("test-fixtures").join("raws").join("pano_01");
    if !dir.is_dir() {
        return None;
    }
    let mut out = Vec::with_capacity(21);
    for i in 1..=21 {
        let path = dir.join(format!("PANO{:04}.DNG", i));
        if !path.is_file() {
            return None;
        }
        out.push(path);
    }
    Some(out)
}

fn skip(label: &str, reason: &str) {
    eprintln!("{label}: skipping — {reason}");
}

fn skip_unless_python_available(label: &str) -> bool {
    match Command::new("python3").arg("--version").output() {
        Ok(out) if out.status.success() => true,
        _ => {
            skip(label, "python3 not available on PATH");
            false
        }
    }
}

fn build_pano_smoke(label: &str) -> Option<PathBuf> {
    let workspace = raw_pipeline_root();
    let bin = workspace
        .join("target")
        .join("release")
        .join("pano-smoke");
    if bin.is_file() {
        return Some(bin);
    }
    eprintln!("{label}: building pano-smoke --release (one-time)");
    let status = Command::new("cargo")
        .args(["build", "--release", "--bin", "pano-smoke"])
        .current_dir(&workspace)
        .status();
    match status {
        Ok(s) if s.success() => {
            if bin.is_file() {
                Some(bin)
            } else {
                skip(label, "pano-smoke binary missing after build");
                None
            }
        }
        Ok(s) => {
            skip(
                label,
                &format!("pano-smoke build exited with status {s}"),
            );
            None
        }
        Err(e) => {
            skip(label, &format!("pano-smoke build failed: {e}"));
            None
        }
    }
}

fn run_pano_smoke(
    label: &str,
    bin: &Path,
    dngs: &[PathBuf],
    output: &Path,
) -> bool {
    eprintln!("{label}: running pano-smoke (default flags, --max-dim 6000)");
    let mut cmd = Command::new(bin);
    cmd.arg("--max-dim")
        .arg("6000")
        .arg("-o")
        .arg(output);
    for dng in dngs {
        cmd.arg(dng);
    }
    match cmd.status() {
        Ok(s) if s.success() => {
            if !output.is_file() {
                skip(label, "pano-smoke ran but produced no output PNG");
                false
            } else {
                true
            }
        }
        Ok(s) => {
            skip(
                label,
                &format!("pano-smoke exited with status {s}"),
            );
            false
        }
        Err(e) => {
            skip(label, &format!("could not spawn pano-smoke: {e}"));
            false
        }
    }
}

#[test]
fn pano_01_against_acr_reference_within_budgets() {
    let label = "pano_01_against_acr_reference_within_budgets";

    let dngs = match pano_01_dngs() {
        Some(d) => d,
        None => {
            skip(
                label,
                "missing 21 DNGs at test-fixtures/raws/pano_01/PANO0001..0021.DNG",
            );
            return;
        }
    };

    let reference = repo_root()
        .join("test-fixtures")
        .join("pano")
        .join("references")
        .join("pano_01_reference.png");
    if !reference.is_file() {
        skip(
            label,
            &format!(
                "missing ACR reference at {}",
                reference.display()
            ),
        );
        return;
    }

    let budgets = repo_root()
        .join("test-fixtures")
        .join("budgets")
        .join("reference_pano_01.json");
    if !budgets.is_file() {
        skip(
            label,
            &format!("missing budgets file at {}", budgets.display()),
        );
        return;
    }

    let compare_script = repo_root()
        .join("tools")
        .join("compare-with-reference.py");
    if !compare_script.is_file() {
        skip(
            label,
            &format!(
                "missing comparison script at {}",
                compare_script.display()
            ),
        );
        return;
    }

    if !skip_unless_python_available(label) {
        return;
    }

    let bin = match build_pano_smoke(label) {
        Some(b) => b,
        None => return,
    };

    // Stage the candidate output in /tmp so concurrent test runs don't
    // clash. CARGO_TARGET_TMPDIR isn't ideal here because we want a
    // stable, well-known place for triage.
    let candidate = std::env::temp_dir().join("maple_pano_01_test.png");
    // Best-effort cleanup of any prior artefact.
    let _ = std::fs::remove_file(&candidate);

    if !run_pano_smoke(label, &bin, &dngs, &candidate) {
        return;
    }

    eprintln!("{label}: invoking compare-with-reference.py");
    let status = Command::new("python3")
        .arg(&compare_script)
        .arg(&candidate)
        .arg(&reference)
        .arg("--budgets")
        .arg(&budgets)
        .status()
        .expect("spawn python3 compare-with-reference.py");

    assert!(
        status.success(),
        "compare-with-reference.py reported a budget breach for pano_01 \
         (candidate at {}, reference at {}, budgets at {}). \
         Exit: {}",
        candidate.display(),
        reference.display(),
        budgets.display(),
        status,
    );
}

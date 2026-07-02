//! `maple-cli diff` — wrap `src/scripts/compare_images.py` so the parity
//! harnesses can stay in one binary. Prints the script's JSON to stdout
//! verbatim and exits non-zero when `--budget` is set and the mean ΔE
//! exceeds it.

use std::path::Path;
use std::process::Command;

pub fn run(
    candidate: &Path,
    reference: &Path,
    budget: Option<f32>,
) -> Result<i32, Box<dyn std::error::Error>> {
    if !candidate.is_file() {
        return Err(format!(
            "diff: candidate path is not a file: {}",
            candidate.display()
        )
        .into());
    }
    if !reference.is_file() {
        return Err(format!(
            "diff: reference path is not a file: {}",
            reference.display()
        )
        .into());
    }

    // Locate compare_images.py by walking ancestors of the current working
    // directory, then falling back to the binary's own location ancestors.
    let script = std::env::current_dir()?
        .ancestors()
        .find_map(|a| {
            let p = a.join("src/scripts/compare_images.py");
            if p.exists() {
                Some(p)
            } else {
                None
            }
        })
        .ok_or("src/scripts/compare_images.py not found in any parent directory")?;

    let output = Command::new("python3")
        .arg("--")
        .arg(&script)
        .arg("--")
        .arg(candidate)
        .arg(reference)
        .output()?;

    if !output.status.success() {
        return Err(format!(
            "compare_images.py failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    print!("{}", stdout);

    if let Some(b) = budget {
        let mean = parse_mean_delta_e(&stdout)?;
        if mean > b {
            eprintln!("diff: mean \u{0394}E {} exceeds budget {}", mean, b);
            return Ok(1);
        }
    }

    Ok(0)
}

/// Parse `mean_deltaE` out of compare_images.py's JSON without a dedicated
/// serde target. Unparseable compare output is an ERROR, not a pass — a
/// `--budget` caller asked for a verdict, and silently returning 0 when the
/// metric can't be read fails open (#1082).
fn parse_mean_delta_e(stdout: &str) -> Result<f32, String> {
    let key = "\"mean_deltaE\":";
    let i = stdout.find(key).ok_or_else(|| {
        format!(
            "diff: --budget set but compare output has no {} field; \
             cannot enforce the budget. Output was:\n{}",
            key, stdout
        )
    })?;
    let rest = &stdout[i + key.len()..];
    let end = rest.find([',', '}']).unwrap_or(rest.len());
    let num_str = rest[..end].trim();
    num_str.parse::<f32>().map_err(|e| {
        format!(
            "diff: --budget set but mean_deltaE value {:?} is unparseable ({}); \
             cannot enforce the budget",
            num_str, e
        )
    })
}

#[cfg(test)]
mod tests {
    use super::parse_mean_delta_e;

    #[test]
    fn parses_mean_from_compare_json() {
        let out = r#"{"mean_deltaE": 1.25, "p95_deltaE": 3.0, "max_deltaE": 9.5}"#;
        assert_eq!(parse_mean_delta_e(out).unwrap(), 1.25);
    }

    #[test]
    fn parses_mean_when_field_is_last() {
        let out = r#"{"p95_deltaE": 3.0, "mean_deltaE":0.5}"#;
        assert_eq!(parse_mean_delta_e(out).unwrap(), 0.5);
    }

    /// Fail-closed (#1082): output without the field used to slip through
    /// as `Ok(0)` — a budget verdict on nothing.
    #[test]
    fn missing_field_is_an_error_not_a_pass() {
        let err = parse_mean_delta_e("Traceback (most recent call last): ...").unwrap_err();
        assert!(err.contains("no \"mean_deltaE\":"), "got: {err}");
    }

    /// Fail-closed (#1082): an unparseable value used to slip through too.
    #[test]
    fn unparseable_value_is_an_error_not_a_pass() {
        let err = parse_mean_delta_e(r#"{"mean_deltaE": NaN-ish garbage}"#).unwrap_err();
        assert!(err.contains("unparseable"), "got: {err}");
    }
}

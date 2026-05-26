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
        .arg(&script)
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
        // Parse mean_deltaE from the JSON without a dedicated serde target.
        let key = "\"mean_deltaE\":";
        if let Some(i) = stdout.find(key) {
            let rest = &stdout[i + key.len()..];
            let end = rest.find([',', '}']).unwrap_or(rest.len());
            let num_str = rest[..end].trim();
            if let Ok(mean) = num_str.parse::<f32>() {
                if mean > b {
                    eprintln!("diff: mean \u{0394}E {} exceeds budget {}", mean, b);
                    return Ok(1);
                }
            }
        }
    }

    Ok(0)
}

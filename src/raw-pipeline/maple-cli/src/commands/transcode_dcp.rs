//! `maple-cli transcode-dcp` — repack a v1 (inline) DCP `profiles.bin` into
//! the **v3 split** layout (ticket #829, design PR #831).
//!
//! Reads a v1 bundle, dedups its HSM tables into a pooled, per-entry-zlib pool
//! region, and writes the always-resident index region + the separately
//! addressable pool region. Matrices and HSM bytes are copied verbatim, so the
//! resolved profile data is byte-identical across the repack.
//!
//! Output forms (controlled by `--out` / `--out-pool`):
//!   * `--out a.idx --out-pool a.pool` — the two-file split (web-preferred: the
//!     index isn't re-downloaded with every pool fetch).
//!   * `--out a.bin` (no `--out-pool`) — the combined single-file form (index
//!     region then pool region; directory offsets pool-relative), what the
//!     native embedded fallback uses.
//!
//! Per the design's asset-size open item (#831 line 29), this PRINTS the pool
//! byte size + dedup stats so #829 validates that per-entry zlib stays in the
//! ~24-25 MB class rather than asserting it.

use std::path::Path;

use raw_core::color::profile_loader;

/// Transcode `src` (a v1 `profiles.bin`) → v3 split layout.
///
/// When `out_pool` is `Some`, writes the two-file split (`out` = index,
/// `out_pool` = pool). When `None`, writes the combined single file to `out`.
pub fn run(
    src: &Path,
    out: &Path,
    out_pool: Option<&Path>,
) -> Result<i32, Box<dyn std::error::Error>> {
    let v1 = std::fs::read(src)?;
    let enc = profile_loader::transcode_v1_to_v3(&v1).ok_or_else(|| {
        format!(
            "transcode-dcp: {} is not a valid v1 (inline) profiles.bin \
             (bad magic, wrong version, or truncated record)",
            src.display()
        )
    })?;

    let dedup_pct = if enc.hsm_instances > 0 {
        100.0 * (1.0 - enc.pool_count as f64 / enc.hsm_instances as f64)
    } else {
        0.0
    };

    eprintln!("transcode-dcp: v1 → v3 split");
    eprintln!("  HSM instances:  {}", enc.hsm_instances);
    eprintln!(
        "  unique tables:  {}  ({:.1}% deduped)",
        enc.pool_count, dedup_pct
    );
    eprintln!(
        "  index region:   {} bytes ({:.1} KB) — always-resident",
        enc.idx.len(),
        enc.idx.len() as f64 / 1024.0
    );
    eprintln!(
        "  pool region:    {} bytes ({:.2} MB) — lazy-fetchable",
        enc.pool.len(),
        enc.pool.len() as f64 / (1024.0 * 1024.0)
    );

    match out_pool {
        Some(pool_path) => {
            std::fs::write(out, &enc.idx)?;
            std::fs::write(pool_path, &enc.pool)?;
            eprintln!(
                "  wrote split:    {} (index) + {} (pool)",
                out.display(),
                pool_path.display()
            );
        }
        None => {
            let combined = enc.combined();
            eprintln!(
                "  combined size:  {} bytes ({:.2} MB)",
                combined.len(),
                combined.len() as f64 / (1024.0 * 1024.0)
            );
            std::fs::write(out, &combined)?;
            eprintln!("  wrote combined: {}", out.display());
        }
    }

    Ok(0)
}

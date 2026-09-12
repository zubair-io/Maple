//! CLI-side lens-profile plumbing for `maple-cli render` (#2435).
//!
//! Split out of `render.rs` rather than living beside the pipeline calls: that
//! file sits close to the file-size budget, and these two helpers are the only
//! part of the render command that knows about LCP documents at all.

use clap::Args;
use raw_core::xmp;
use std::path::{Path, PathBuf};

type CliResult<T> = Result<T, Box<dyn std::error::Error>>;

/// `maple-cli render`'s lens-profile flags, flattened into the command so
/// `main.rs` (at the budget-headroom ceiling) carries one line for them.
#[derive(Args, Debug, Default)]
pub struct LensProfileArgs {
    /// Import this user-owned LCP and select its exact content for this render.
    #[arg(long)]
    pub lens_profile: Option<PathBuf>,
    /// Explicitly accept the LCP resolver's reported out-of-range conditions.
    #[arg(long, requires = "lens_profile")]
    pub acknowledge_lens_approximation: bool,
    /// Bundled Lensfun correction: `auto` (the default — match the RAW's
    /// EXIF identity), `off` (master toggle off), or a `<maker>/<lens>@<mount>`
    /// slug from `maple-cli inspect <raw>`.
    #[arg(long, value_name = "auto|off|<slug>", conflicts_with = "lens_profile")]
    pub lens: Option<String>,
    /// Instead of rendering, write the resolved lens correction's warp field
    /// (source coordinates per channel and vignetting gain on a 17×11 grid)
    /// as JSON — the input of `src/scripts/lens_warp_diff.py`.
    #[arg(long, value_name = "FILE")]
    pub lens_warp_out: Option<PathBuf>,
    /// Never apply the bundled Lensfun match (embedded corrections and
    /// explicit selections still apply). The colour harness renders with
    /// this so it compares against ACR references made without lens
    /// correction.
    #[arg(long = "no-bundled-lens")]
    pub no_bundled_lens: bool,
}

impl LensProfileArgs {
    /// The `(path, acknowledged)` pair `render::run` takes, or `None` when no
    /// profile was named.
    pub fn selection(&self) -> Option<(&Path, bool)> {
        self.lens_profile
            .as_deref()
            .map(|path| (path, self.acknowledge_lens_approximation))
    }
}

/// Register an LCP document and record the resulting reference on `model`.
///
/// `acknowledged` selects the `lcp1-ack:` form, which records that the operator
/// accepted the approximations the registration reported. Registration failure
/// is an error rather than a silent fallback — a profile the caller named but
/// that cannot be read must never turn into an unannounced change of optical
/// correction.
pub fn apply_lens_profile_selection(
    model: &mut xmp::AdjustmentModel,
    path: &Path,
    acknowledged: bool,
) -> CliResult<()> {
    let registration = raw_core::lens_profile::register(&std::fs::read_to_string(path)?)?;
    let reference = registration["reference"]
        .as_str()
        .ok_or("LCP registration has no reference")?;
    model.lens_profile = if acknowledged {
        reference.replacen("lcp1:", "lcp1-ack:", 1)
    } else {
        reference.to_owned()
    };
    eprintln!("LCP selection: {}", model.lens_profile);
    Ok(())
}

/// Apply a `--lens` choice to the model: `auto` leaves the automatic match
/// in place, `off` turns the master toggle off, a slug pins a bundled lens
/// (validated against the bundle before anything renders).
pub fn apply_lens_choice(model: &mut xmp::AdjustmentModel, choice: &str) -> CliResult<()> {
    match choice {
        "auto" => model.lens_profile.clear(),
        "off" => model.lens_profile_enable = raw_core::types::adjustment::LensProfileEnable::Off,
        slug => {
            // Any crop factor is acceptable here: the render resolves the
            // calibration set for the actual body, this only rejects typos.
            let db = raw_core::lens_profile::lensfun::database();
            if raw_core::lens_profile::lensfun::by_slug(db, slug, 1e9).is_none() {
                return Err(format!(
                    "`{slug}` is not a bundled lens; `maple-cli inspect <raw>` lists them"
                )
                .into());
            }
            model.lens_profile = format!("lensfun1:{slug}");
        }
    }
    eprintln!("Lens choice: {choice}");
    Ok(())
}

/// Print real resolver evidence once per CLI render, including embedded
/// priority and the automatic bundled match.
pub fn report_lens_resolution(
    raw: &raw_core::RawImage,
    model: &xmp::AdjustmentModel,
) -> CliResult<()> {
    if raw.opcode_list3.is_some() {
        if !model.lens_profile.is_empty() {
            eprintln!(
                "Lens correction source: embedded OpcodeList3 (external profile not applied)"
            );
        }
        return Ok(());
    }
    if let Some(evidence) = raw_core::lens_profile::evidence_for(raw, model)? {
        eprintln!("Lens correction: {evidence}");
    }
    Ok(())
}

/// Grid density of the warp dump: 17 columns × 11 rows over the active area.
const WARP_GRID: (usize, usize) = (17, 11);

/// When `--lens-warp-out` is set, decode the RAW, resolve the correction
/// the render would apply, and write its warp field instead of pixels.
/// Returns `true` when a dump was written (the caller then skips rendering).
pub fn maybe_dump_warp(
    raw_path: &Path,
    model: &xmp::AdjustmentModel,
    out: Option<&Path>,
) -> CliResult<bool> {
    let Some(out) = out else {
        return Ok(false);
    };
    let bytes = std::fs::read(raw_path)?;
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = raw_core::decode::decode_bytes(&bytes, ext)?;
    let resolution = raw_core::lens_profile::resolve_for_model(&raw, model)?
        .ok_or("No external lens correction resolves for this RAW and selection")?;
    let (w, h) = raw
        .lens_metadata
        .active_area
        .map(|a| (f64::from(a.width), f64::from(a.height)))
        .unwrap_or((f64::from(raw.width), f64::from(raw.height)));
    let cal = &resolution.calibration;
    let mut points = Vec::new();
    for row in 0..WARP_GRID.1 {
        for col in 0..WARP_GRID.0 {
            let x = (w - 1.0) * col as f64 / (WARP_GRID.0 - 1) as f64;
            let y = (h - 1.0) * row as f64 / (WARP_GRID.1 - 1) as f64;
            let green = cal
                .distortion
                .map(|d| d.map(w, h, [x, y]))
                .unwrap_or([x, y]);
            let channel = |c: usize| cal.ca.map(|ca| ca.map(w, h, green, c)).unwrap_or(green);
            let gain = cal
                .vignette
                .and_then(|v| v.gain(w, h, [x, y]))
                .unwrap_or(1.0);
            points.push(serde_json::json!({
                "out": [x, y], "red": channel(0), "green": green, "blue": channel(2), "gain": gain,
            }));
        }
    }
    let dump = serde_json::json!({
        "width": w, "height": h, "grid": [WARP_GRID.0, WARP_GRID.1],
        "evidence": resolution.metadata(),
        "points": points,
    });
    std::fs::write(out, serde_json::to_string_pretty(&dump)?)?;
    eprintln!("Lens warp written to {}", out.display());
    Ok(true)
}

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
#[derive(Args, Debug)]
pub struct LensProfileArgs {
    /// Import this user-owned LCP and select its exact content for this render.
    #[arg(long)]
    pub lens_profile: Option<PathBuf>,
    /// Explicitly accept the LCP resolver's reported out-of-range conditions.
    #[arg(long, requires = "lens_profile")]
    pub acknowledge_lens_approximation: bool,
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

/// Print real resolver evidence once per CLI render, including embedded priority.
pub fn report_lens_resolution(
    raw: &raw_core::RawImage,
    model: &xmp::AdjustmentModel,
) -> CliResult<()> {
    if model.lens_profile.is_empty() {
        return Ok(());
    }
    if raw.opcode_list3.is_some() {
        eprintln!("Lens correction source: embedded OpcodeList3 (external profile not applied)");
    } else if let Some(resolution) =
        raw_core::lens_profile::resolve_for_raw(raw, &model.lens_profile)?
    {
        eprintln!("Lens correction: {}", resolution.metadata());
    }
    Ok(())
}

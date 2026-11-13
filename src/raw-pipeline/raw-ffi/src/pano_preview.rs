//! Quick panorama preview and alignment-reusing stitch C-FFI (#4578).
//!
//! `maple_pano_preview` writes a display-encoded preview PNG (~2048 px long
//! edge, solved and composited from the proxies — no full-resolution
//! refinement) plus the solved alignment as a JSON file.
//! `maple_pano_stitch_aligned` is `maple_pano_stitch` with that alignment
//! offered: when the inputs and geometry options still match, matching and
//! graph verification are skipped and the output is the same image a fresh
//! stitch with the same options produces.
//!
//! Same ABI conventions and negative codes as `maple_pano_stitch` (see
//! `pano.rs`), plus one positive soft code:
//!
//! ```text
//!  1   success, but the offered alignment was stale or unreadable, so
//!      matching re-ran; `maple_last_error()` names the reason
//! −5   an output or alignment path is not valid UTF-8
//! −10  `edges.boundary_warp` is not a percent from 0 to 100
//! ```
//!
//! Both take Boundary Warp and Auto Crop as [`MaplePanoEdges`] and report
//! what they did through an optional [`MaplePanoEdgesReport`] (#5574).

use std::ffi::{c_char, c_void, CStr};

use crate::cancel::SendCancelPtr;
use crate::error::set_last_error;
use crate::MapleCancelFlag;

#[cfg(any(target_os = "macos", target_os = "ios"))]
use crate::error::with_large_stack;

use super::pano_edges::{MaplePanoEdges, MaplePanoEdgesReport};
use super::{
    MaplePanoFeatureEngine, MaplePanoLocalAlign, MaplePanoProgressFn, MaplePanoRetention,
    MaplePanoStrategy, SendProgressCallback,
};

/// # Safety
/// `raw_paths` must point to `count` C strings (or be null).
unsafe fn owned_paths(
    fn_name: &str,
    raw_paths: *const *const c_char,
    count: usize,
) -> Result<Vec<String>, i32> {
    if raw_paths.is_null() {
        set_last_error(format!("{fn_name}: null pointer in required argument"));
        return Err(-1);
    }
    if count < 2 {
        set_last_error(format!(
            "{fn_name}: need at least 2 input frames, got {count}"
        ));
        return Err(-2);
    }
    (0..count)
        .map(|i| {
            let ptr = *raw_paths.add(i);
            if ptr.is_null() {
                set_last_error(format!("{fn_name}: raw_paths[{i}] is null"));
                return Err(-4);
            }
            CStr::from_ptr(ptr)
                .to_str()
                .map(str::to_owned)
                .map_err(|e| {
                    set_last_error(format!("{fn_name}: raw_paths[{i}] not UTF-8: {e}"));
                    -4
                })
        })
        .collect()
}

/// # Safety
/// `ptr` must be null or a valid C string.
unsafe fn optional_path(
    fn_name: &str,
    arg: &str,
    ptr: *const c_char,
) -> Result<Option<String>, i32> {
    if ptr.is_null() {
        return Ok(None);
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map(|s| Some(s.to_owned()))
        .map_err(|e| {
            set_last_error(format!("{fn_name}: {arg} not UTF-8: {e}"));
            -5
        })
}

/// # Safety
/// `ptr` must be null or a valid C string.
unsafe fn required_path(fn_name: &str, arg: &str, ptr: *const c_char) -> Result<String, i32> {
    optional_path(fn_name, arg, ptr)?.ok_or_else(|| {
        set_last_error(format!(
            "{fn_name}: null pointer in required argument {arg}"
        ));
        -1
    })
}

/// Sizes a preview reports about the full stitch it previews.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MaplePanoPreviewSizes {
    /// Estimated full-stitch canvas width under the preview's options and
    /// the default canvas cap.
    pub full_width: u32,
    /// Estimated full-stitch canvas height.
    pub full_height: u32,
    /// Pixel count of the largest input frame at full resolution.
    pub largest_frame_px: u64,
    /// Bytes the full stitch reserves on the temp volume for its decoded
    /// frames, whatever the output size.
    pub scratch_bytes: u64,
}

/// Remove the decoded-frame stores a killed stitch left in the system temp
/// directory, keeping any whose process is still running. Call at launch,
/// before any stitch starts. Always returns `0`.
#[no_mangle]
pub extern "C" fn maple_pano_sweep_scratch() -> i32 {
    crate::error::catch_panic_rc("maple_pano_sweep_scratch", || {
        maple_pano::stitch::sweep_orphaned_scratch();
        0
    })
}

/// Build a quick low-resolution panorama preview.
///
/// `raw_paths`/`count` — as `maple_pano_stitch` (≥ 2 UTF-8 paths).
/// `out_preview_png_path` — required; receives the display-encoded sRGB
///   16-bit PNG, long edge ≈ 2048 px.
/// `alignment_in_path` — optional (null = none); a file this function or
///   `maple_pano_stitch_aligned` wrote earlier. Reused when it still matches.
/// `alignment_out_path` — optional (null = don't write); receives the
///   solved (or reused) alignment JSON to hand to `maple_pano_stitch_aligned`.
/// `out_sizes` — optional (null = don't report); receives what the full
///   stitch will hold (see [`MaplePanoPreviewSizes`]) so the caller can size
///   its memory budget and pick a `max_canvas_px` for
///   `maple_pano_stitch_aligned`. Written only when the return is ≥ 0.
///   The sizes are the canvas's, which the memory use follows.
/// `edges` — Boundary Warp strength and Auto Crop; `{0, false}` changes
///   nothing. The preview PNG comes back warped but whole: Auto Crop only
///   reports its rectangle through `out_edges`. Neither is part of the
///   alignment's key, so changing them reuses the alignment.
/// `out_edges` — optional (null = don't report); what `edges` did to the
///   preview. Written only when the return is ≥ 0.
/// Remaining arguments (including `engine`) as `maple_pano_stitch`. Progress stage 3
/// (refinement) is reported complete immediately — the preview skips it.
///
/// Returns 0 on success, 1 when an offered alignment was not reused (see
/// the module table), negative on error.
///
/// # Safety
///
/// Same contract as `maple_pano_stitch`; every path pointer must be null
/// (where optional) or a valid null-terminated C string for the call.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_pano_preview(
    raw_paths: *const *const c_char,
    count: usize,
    out_preview_png_path: *const c_char,
    alignment_in_path: *const c_char,
    alignment_out_path: *const c_char,
    out_sizes: *mut MaplePanoPreviewSizes,
    edges: MaplePanoEdges,
    out_edges: *mut MaplePanoEdgesReport,
    retention: MaplePanoRetention,
    local_align: MaplePanoLocalAlign,
    strategy: MaplePanoStrategy,
    engine: MaplePanoFeatureEngine,
    progress_cb: MaplePanoProgressFn,
    cb_user: *mut c_void,
    cancel: *const MapleCancelFlag,
) -> i32 {
    const NAME: &str = "maple_pano_preview";
    let parsed = owned_paths(NAME, raw_paths, count).and_then(|paths| {
        Ok((
            paths,
            required_path(NAME, "out_preview_png_path", out_preview_png_path)?,
            optional_path(NAME, "alignment_in_path", alignment_in_path)?,
            optional_path(NAME, "alignment_out_path", alignment_out_path)?,
        ))
    });
    let (paths, out_png, alignment_in, alignment_out) = match parsed {
        Ok(p) => p,
        Err(rc) => return rc,
    };
    let cb = SendProgressCallback {
        f: progress_cb,
        user: cb_user,
    };
    let send_cancel = SendCancelPtr(cancel);

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let opts = match super::pano_edges::with_edges(
            NAME,
            super::pano_apple::stitch_options(retention, local_align, strategy, engine),
            edges,
        ) {
            Ok(opts) => opts,
            Err(rc) => return rc,
        };
        let full = std::sync::Arc::new(std::sync::OnceLock::new());
        let worker_full = std::sync::Arc::clone(&full);
        let rc = with_large_stack(move || {
            let (rc, estimate) = apple::run_preview(
                paths,
                out_png,
                alignment_in,
                alignment_out,
                opts,
                cb,
                send_cancel,
            );
            if let Some(reported) = estimate {
                let _ = worker_full.set(reported);
            }
            rc
        });
        if let Some(&(sizes, reported)) = full.get() {
            if !out_sizes.is_null() {
                *out_sizes = sizes;
            }
            if !out_edges.is_null() {
                *out_edges = reported;
            }
        }
        rc
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (
            paths,
            out_png,
            alignment_in,
            alignment_out,
            out_sizes,
            edges,
            out_edges,
            retention,
            local_align,
            strategy,
            engine,
            cb,
            send_cancel,
        );
        set_last_error(format!(
            "{NAME}: not supported on this platform (pano is Apple-only)"
        ));
        -3
    }
}

/// `maple_pano_stitch` starting from a preview's solved alignment.
///
/// `alignment_in_path` — optional (null behaves exactly like
/// `maple_pano_stitch`). When the file matches the inputs and geometry
/// options, decode-to-proxy, feature extraction, matching and graph
/// verification are skipped; when it is stale or unreadable the stitch
/// re-solves and returns 1.
/// `max_canvas_px` — the output canvas pixel cap; a canvas larger than this
///   is shrunk uniformly to fit. 0 = the default cap (256 MP). A smaller cap
///   lowers the composite's memory, not decode or refinement's.
/// `edges`, `out_edges` — as `maple_pano_preview`, for the full stitch.
/// All other arguments and codes as `maple_pano_stitch`.
///
/// # Safety
///
/// Same contract as `maple_pano_stitch`; `alignment_in_path` must be null
/// or a valid null-terminated C string for the call.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_pano_stitch_aligned(
    raw_paths: *const *const c_char,
    count: usize,
    out_png_path: *const c_char,
    alignment_in_path: *const c_char,
    max_canvas_px: u64,
    edges: MaplePanoEdges,
    out_edges: *mut MaplePanoEdgesReport,
    retention: MaplePanoRetention,
    local_align: MaplePanoLocalAlign,
    strategy: MaplePanoStrategy,
    engine: MaplePanoFeatureEngine,
    progress_cb: MaplePanoProgressFn,
    cb_user: *mut c_void,
    cancel: *const MapleCancelFlag,
) -> i32 {
    const NAME: &str = "maple_pano_stitch_aligned";
    let parsed = owned_paths(NAME, raw_paths, count).and_then(|paths| {
        Ok((
            paths,
            required_path(NAME, "out_png_path", out_png_path)?,
            optional_path(NAME, "alignment_in_path", alignment_in_path)?,
        ))
    });
    let (paths, out_png, alignment_in) = match parsed {
        Ok(p) => p,
        Err(rc) => return rc,
    };
    let cb = SendProgressCallback {
        f: progress_cb,
        user: cb_user,
    };
    let send_cancel = SendCancelPtr(cancel);

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let opts = match super::pano_edges::with_edges(
            NAME,
            with_canvas_cap(
                super::pano_apple::stitch_options(retention, local_align, strategy, engine),
                max_canvas_px,
            ),
            edges,
        ) {
            Ok(opts) => opts,
            Err(rc) => return rc,
        };
        let reported = std::sync::Arc::new(std::sync::OnceLock::new());
        let worker_reported = std::sync::Arc::clone(&reported);
        let rc = with_large_stack(move || {
            let (rc, edges) = super::pano_apple::run_stitch_apple(
                paths,
                out_png,
                alignment_in,
                opts,
                cb,
                send_cancel,
            );
            if let Some(edges) = edges {
                let _ = worker_reported.set(MaplePanoEdgesReport::from(&edges));
            }
            rc
        });
        if let (Some(&edges), false) = (reported.get(), out_edges.is_null()) {
            *out_edges = edges;
        }
        rc
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (
            paths,
            out_png,
            alignment_in,
            max_canvas_px,
            edges,
            out_edges,
            retention,
            local_align,
            strategy,
            engine,
            cb,
            send_cancel,
        );
        set_last_error(format!(
            "{NAME}: not supported on this platform (pano is Apple-only)"
        ));
        -3
    }
}

/// `opts` with its canvas cap replaced by `max_canvas_px` (0 keeps it).
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
fn with_canvas_cap(
    opts: maple_pano::stitch::StitchOptions,
    max_canvas_px: u64,
) -> maple_pano::stitch::StitchOptions {
    match usize::try_from(max_canvas_px) {
        Ok(0) | Err(_) => opts,
        Ok(cap) => maple_pano::stitch::StitchOptions {
            max_canvas_px: cap,
            ..opts
        },
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use std::path::{Path, PathBuf};

    use maple_pano::render::{write_frame_png, PngMetadata};
    use maple_pano::stitch::{preview, StitchOptions};

    use crate::cancel::SendCancelPtr;
    use crate::error::set_last_error;

    use super::super::pano_apple::{
        cancel_adapter, error_rc, progress_adapter, read_alignment, reuse_rc,
    };
    use super::super::SendProgressCallback;

    const NAME: &str = "maple_pano_preview";

    pub(super) fn run_preview(
        input_paths: Vec<String>,
        out_png: String,
        alignment_in: Option<String>,
        alignment_out: Option<String>,
        opts: StitchOptions,
        cb: SendProgressCallback,
        send_cancel: SendCancelPtr,
    ) -> (
        i32,
        Option<(super::MaplePanoPreviewSizes, super::MaplePanoEdgesReport)>,
    ) {
        let inputs: Vec<PathBuf> = input_paths.iter().map(PathBuf::from).collect();
        let (offered, unreadable) = read_alignment(alignment_in.as_deref());
        let result = preview(
            &inputs,
            &opts,
            offered.as_ref(),
            progress_adapter(cb),
            cancel_adapter(send_cancel),
        );
        let pv = match result {
            Ok(pv) => pv,
            Err(e) => return (error_rc(NAME, e), None),
        };
        let written = write_frame_png(
            Path::new(&out_png),
            pv.width,
            pv.height,
            &pv.display_rgb16,
            &PngMetadata {
                exif_blob: None,
                tag_srgb: true,
            },
        )
        .map_err(|e| format!("write preview PNG: {e}"))
        .and_then(|()| {
            alignment_out.map_or(Ok(()), |p| {
                std::fs::write(&p, pv.alignment.to_json())
                    .map_err(|e| format!("write alignment {p}: {e}"))
            })
        });
        match written {
            Ok(()) => (
                reuse_rc(NAME, &pv.reuse, unreadable),
                Some((
                    super::MaplePanoPreviewSizes {
                        full_width: pv.full_canvas_estimate.0,
                        full_height: pv.full_canvas_estimate.1,
                        largest_frame_px: pv.largest_frame_px,
                        scratch_bytes: pv.scratch_bytes,
                    },
                    super::MaplePanoEdgesReport::from(&pv.edges),
                )),
            ),
            Err(msg) => {
                set_last_error(format!("{NAME}: {msg}"));
                (-7, None)
            }
        }
    }
}

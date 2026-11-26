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
//! −12  the memory model puts the run over `memory_limit_bytes` (the
//!      `_constrained` entries); nothing was developed past the check
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
    maple_pano_preview_constrained(
        raw_paths,
        count,
        out_preview_png_path,
        alignment_in_path,
        alignment_out_path,
        out_sizes,
        edges,
        out_edges,
        retention,
        local_align,
        strategy,
        engine,
        std::ptr::null(),
        0,
        std::ptr::null(),
        progress_cb,
        cb_user,
        cancel,
    )
}

/// Build a proxy-only preview with a versioned seam-constraint JSON request.
/// Null leaves seams unconstrained. Invalid requests return −11
/// (`invalid_seam_constraints`) before decode. Alignment reuse and stale
/// geometry reporting are identical to [`maple_pano_preview`].
///
/// `memory_limit_bytes` — refuse with −12, before any frame is developed,
///   when the Apple memory model puts the preview over this many bytes;
///   0 = no limit.
/// `proxy_cache_dir` — optional (null = none); a directory the caller owns
///   where each frame's proxy is kept between calls, so a re-preview of the
///   same frames reads them back instead of developing every RAW again.
///   Holds at most the latest call's frames.
///
/// # Safety
/// Same pointer contract as [`maple_pano_preview`]; `seam_constraints_json`
/// must be null or a valid UTF-8 C string for the synchronous call.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_pano_preview_constrained(
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
    seam_constraints_json: *const c_char,
    memory_limit_bytes: u64,
    proxy_cache_dir: *const c_char,
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
            optional_path(NAME, "proxy_cache_dir", proxy_cache_dir)?,
        ))
    });
    let (paths, out_png, alignment_in, alignment_out, cache_dir) = match parsed {
        Ok(p) => p,
        Err(rc) => return rc,
    };
    let request = match seam_request(NAME, seam_constraints_json, count, strategy) {
        Ok(request) => request,
        Err(rc) => return rc,
    };
    let cb = SendProgressCallback {
        f: progress_cb,
        user: cb_user,
    };
    let send_cancel = SendCancelPtr(cancel);

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let mut opts = match super::pano_edges::with_edges(
            NAME,
            super::pano_apple::stitch_options(retention, local_align, strategy, engine),
            edges,
        ) {
            Ok(opts) => opts,
            Err(rc) => return rc,
        };
        opts.memory_limit_bytes = (memory_limit_bytes > 0).then_some(memory_limit_bytes);
        opts.proxy_cache_dir = cache_dir.map(std::path::PathBuf::from);
        if request.is_some() {
            opts.seam_strategy = maple_pano::seam::SeamStrategy::GraphCut;
            opts.seam_constraints = request;
        }
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
            request,
            memory_limit_bytes,
            cache_dir,
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
    maple_pano_stitch_constrained(
        raw_paths,
        count,
        out_png_path,
        alignment_in_path,
        max_canvas_px,
        edges,
        out_edges,
        retention,
        local_align,
        strategy,
        engine,
        std::ptr::null(),
        0,
        progress_cb,
        cb_user,
        cancel,
    )
}

/// Stitch with a versioned seam-constraint JSON request. Null leaves seams unconstrained.
/// Invalid requests return −11 (`invalid_seam_constraints`) before decode.
/// `memory_limit_bytes` — refuse with −12 when the Apple memory model puts the decode,
/// matching or composite over this many bytes, before that phase starts; 0 = no limit.
///
/// # Safety
/// Same pointer contract as `maple_pano_stitch_aligned`; `seam_constraints_json`
/// must be null or a valid UTF-8 C string for the synchronous call.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_pano_stitch_constrained(
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
    seam_constraints_json: *const c_char,
    memory_limit_bytes: u64,
    progress_cb: MaplePanoProgressFn,
    cb_user: *mut c_void,
    cancel: *const MapleCancelFlag,
) -> i32 {
    const NAME: &str = "maple_pano_stitch_constrained";
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
    let request = match seam_request(NAME, seam_constraints_json, count, strategy) {
        Ok(request) => request,
        Err(rc) => return rc,
    };
    let cb = SendProgressCallback {
        f: progress_cb,
        user: cb_user,
    };
    let send_cancel = SendCancelPtr(cancel);

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let mut opts = match super::pano_edges::with_edges(
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
        opts.memory_limit_bytes = (memory_limit_bytes > 0).then_some(memory_limit_bytes);
        if request.is_some() {
            opts.seam_strategy = maple_pano::seam::SeamStrategy::GraphCut;
            opts.seam_constraints = request;
        }
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
            request,
            memory_limit_bytes,
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

/// Parse the shared request before either native pipeline can decode inputs.
///
/// # Safety
/// `json` must be null or a valid C string for the call.
unsafe fn seam_request(
    name: &str,
    json: *const c_char,
    count: usize,
    strategy: MaplePanoStrategy,
) -> Result<Option<maple_pano::seam::SeamConstraintsRequest>, i32> {
    if json.is_null() {
        return Ok(None);
    }
    let parsed = CStr::from_ptr(json)
        .to_str()
        .map_err(|e| e.to_string())
        .and_then(|json| {
            maple_pano::seam::SeamConstraintsRequest::parse(json, count).map_err(|e| e.to_string())
        });
    match parsed {
        Ok(request) if !matches!(strategy, MaplePanoStrategy::Tile) => Ok(Some(request)),
        result => {
            let reason = result
                .err()
                .unwrap_or_else(|| "constraints require rotation".into());
            set_last_error(format!("{name}: invalid_seam_constraints: {reason}"));
            Err(-11)
        }
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
#[path = "pano_preview_apple.rs"]
mod apple;

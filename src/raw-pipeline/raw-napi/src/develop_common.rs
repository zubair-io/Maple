//! Shared helpers for `develop_export.rs` / `develop_preview.rs` (#3509 Task
//! 6): the RAW-develop export + thumbnail-extraction bindings.
//!
//! **Why a dedicated big-stack thread for RAW decode.** Several operations
//! in the sibling files call `raw_core::decode::decode_bytes` — a full RAW
//! decode, not just a header read. `raw-ffi/src/error.rs`'s
//! `with_large_stack` exists because rawler's per-format decoders (CR3 in
//! particular) allocate several MB of Huffman/JPEG-LS scratch ON THE STACK,
//! and a thread with too small a stack segfaults partway through rather
//! than returning a normal `Err` — undefined behaviour, not a catchable
//! failure.
//!
//! A `Task`/`AsyncTask`'s `compute()` already runs off the JS thread, on one
//! of Node's own libuv threadpool workers. Since libuv 1.45 (mid-2023;
//! every Node LTS this crate can plausibly run under ships well past that)
//! those workers get a fixed 8 MB stack on every platform; before that
//! release the stack was whatever the OS defaults a secondary thread to,
//! which on macOS is 512 KB — the exact failure mode `raw-ffi`'s own doc
//! comment describes for Swift's cooperative pool. 8 MB is very likely
//! enough headroom on its own, but "very likely" is a bad place to stand for
//! a failure mode that aborts the whole Node process instead of rejecting
//! one `Promise`. So, matching `raw-ffi`'s own belt-and-braces reasoning,
//! [`run_on_large_stack`] runs the decode on its OWN dedicated 16 MB-stack
//! thread rather than trusting whatever stack the calling libuv worker
//! happens to have — one extra thread spawn on an already-asynchronous
//! operation, in exchange for removing a crash class no `Result` can
//! express.
//!
//! The two thumbnail operations in `develop_preview.rs` deliberately do NOT
//! route through this: `raw_core::preview::extract_embedded_preview` decodes
//! only the RAW's already-embedded JPEG preview — an ordinary-sized JPEG
//! decode with none of the CR3-style stack pressure — so they run directly
//! on the calling `Task`'s own thread, same as `raw-ffi/src/thumbnail.rs`
//! (which skips its own `with_large_stack` there for a different, Bun-
//! specific reason, but reaches the same "no dedicated thread needed"
//! outcome).

use raw_core::xmp::AdjustmentModel;

/// Stack size for [`run_on_large_stack`]'s dedicated worker thread. Matches
/// `raw-ffi/src/error.rs`'s `WORKER_STACK_BYTES` exactly — physical memory
/// is only committed on demand, so a generous ceiling costs nothing at
/// rest.
const WORKER_STACK_BYTES: usize = 16 * 1024 * 1024;

/// Run `work` on a dedicated thread with a 16 MB stack, propagating its
/// `Result` back to the caller — or a synthesized error if the thread
/// panicked or could not be spawned. See the module doc for why this
/// exists.
pub(crate) fn run_on_large_stack<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    std::thread::Builder::new()
        .stack_size(WORKER_STACK_BYTES)
        .name("raw-napi-decode".to_string())
        .spawn(work)
        .map_err(|e| format!("spawn decode worker failed: {e}"))?
        .join()
        .unwrap_or_else(|_| Err("decode worker panicked".to_string()))
}

/// Load + parse an optional XMP sidecar into an `AdjustmentModel`. `None`
/// (no sidecar path supplied) returns `AdjustmentModel::default()` — the
/// neutral develop, matching every render entry's convention.
///
/// This is `raw-ffi/src/model.rs`'s `load_xmp_model_owned`, minus the
/// `mask_registry::resolve_into` call: that process-wide registry is how an
/// Apple/Windows host that separately registers bitmap-mask rasters over the
/// C ABI makes a `Mask::Bitmap` layer's `raster_id` resolve to real pixels,
/// and `raw-napi` exposes no equivalent registration entry point — no
/// current ticket needs one (YAGNI). Skipping the call changes nothing in
/// practice: with no registrar, every `raster_id` napi could possibly see is
/// already unresolved, and `raw_core`'s own contract for that case is to
/// treat the mask as weight-0 everywhere rather than error or invent a
/// fallback (see `raw-ffi/src/mask_registry.rs`'s module doc) — exactly what
/// happens here without ever calling `resolve_into`.
pub(crate) fn load_xmp_model(xmp_path: Option<&str>) -> Result<AdjustmentModel, String> {
    match xmp_path {
        None => Ok(AdjustmentModel::default()),
        Some(p) => {
            let xml = std::fs::read_to_string(p).map_err(|e| format!("xmp read: {e}"))?;
            raw_core::xmp::parse(&xml).map_err(|e| format!("xmp parse: {e}"))
        }
    }
}

/// Atomic write: write `bytes` to a process-unique `.tmp` sibling of
/// `out_path`, then rename into place, so a reader can never observe a
/// partially-written file. Matches the tmp-then-rename convention every
/// raw-ffi file-output entry this module's callers port
/// (`export_file.rs`, `thumbnail.rs`, `render_develop.rs`) uses, plus the
/// process-id suffix `raw-napi`'s own `raster_resize.rs` already established
/// (`RasterResizeToFileTask::run`) — needed here because napi `Task`s for
/// distinct calls can run concurrently on different libuv worker threads,
/// so two exports racing to the same `out_path` must not share one `.tmp`
/// name.
pub(crate) fn atomic_write(out_path: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp_path = format!("{out_path}.{}.tmp", std::process::id());
    std::fs::write(&tmp_path, bytes).map_err(|e| format!("tmp write: {e}"))?;
    std::fs::rename(&tmp_path, out_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("rename to {out_path} failed: {e}")
    })
}

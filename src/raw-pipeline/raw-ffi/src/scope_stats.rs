//! The C-visible vectorscope statistics block (#3272, spec §5.4, #3277
//! redesign). Hosts own a 16,384-`u32` bins buffer and pass its pointer in
//! `bins_ptr`/`bins_len` alongside this small fixed struct; the FFI writes
//! `frame`/`total`/the bins buffer only when a sample landed (`frame` stays
//! whatever the host last saw otherwise — the render call did not skip the
//! write, there was simply nothing new to report yet).

/// `bins_ptr` points at `bins_len` `u32` slots the HOST allocates and owns
/// (row-major `[cr][cb]`, 128×128 ⇒ `bins_len` must be `16384`), in
/// `raw_core::scope::WEIGHT_SCALE` (1/255) fixed point; `total` is the
/// summed weight in the same fixed point; `frame` is the GPU session's own
/// monotonic counter (see `raw_gpu::ScopeStats`) — it increments per render
/// tick with the scope enabled, NOT per call to this write, so the host can
/// tell a genuinely fresh sample from the same one seen last call (unwritten
/// across a call = unchanged `frame`).
///
/// `bins` is a caller-owned `(ptr, len)` pair, not an inline `[u32; 16384]`
/// array: the inline-array version (#3272) compiled fine in Rust and
/// cbindgen (once the array-length-expression bug was fixed, see the prior
/// revision of this file), but Swift's ClangImporter cannot import a fixed
/// C array that large AT ALL — the field comes back marked `unavailable`,
/// silently dropping it from the generated Swift type with no error at the
/// cbindgen/C level. Only an actual `swift build` caught it (#3277). Every
/// other variable-length array already crossing this crate's C ABI
/// (`MapleGpuLiveParams`'s point arrays, `noise_profile_ptr`/`_len`, etc.)
/// already uses this same host-owns-the-buffer shape, for exactly this
/// reason — this struct is now consistent with that convention instead of
/// being the one exception.
#[repr(C)]
pub struct MapleScopeStats {
    pub frame: u64,
    pub total: u32,
    pub _pad: u32,
    pub bins_ptr: *mut u32,
    pub bins_len: u32,
}

/// Write `(frame, total, bins)` into `out` if non-null, copying `bins` into
/// `out`'s caller-owned buffer when `bins_ptr` is non-null and `bins_len` is
/// large enough. A null `out` is the "the host didn't ask for scope stats on
/// this call" case (mirrors every other optional output pointer in this
/// crate) — silently a no-op, not an error. A null or too-small
/// `out.bins_ptr` skips ONLY the bins copy (`frame`/`total` still land) — a
/// host that wants `total` but not the full histogram isn't forced to
/// allocate a buffer it won't read.
///
/// Takes the three raw fields rather than a `ScopeStats`/`VectorscopeHistogram`
/// type directly: the two callers hand in different source types (the
/// gpu-gated `raw_gpu::ScopeStats`, which HAS its own session-tick `frame`,
/// and the always-available `raw_core::scope::VectorscopeHistogram`, which
/// doesn't — the CPU fused entry supplies a synthetic `frame: 1` instead,
/// since that path is synchronous and "a sample landed" is all it needs to
/// say). Keeping this function type-agnostic means it — and this whole
/// module — never needs the `gpu` feature.
pub(crate) fn write_stats(out: *mut MapleScopeStats, frame: u64, total: u32, bins: &[u32]) {
    if out.is_null() {
        return;
    }
    // SAFETY: the host guarantees `out` points at a live `MapleScopeStats`
    // it owns for the duration of this call, and that `bins_ptr` (if
    // non-null) points at `bins_len` writable `u32` slots for the same
    // duration — the same contract every other FFI entry's output pointer
    // and (ptr, len) buffer pair carries.
    unsafe {
        (*out).frame = frame;
        (*out).total = total;
        let bins_ptr = (*out).bins_ptr;
        let bins_len = (*out).bins_len as usize;
        if !bins_ptr.is_null() && bins_len >= bins.len() {
            std::ptr::copy_nonoverlapping(bins.as_ptr(), bins_ptr, bins.len());
        }
    }
}

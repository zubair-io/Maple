//! The C-visible scope statistics block (#3272, spec §5.4, #3277 redesign,
//! #3251 snapshot). Hosts own a 16,384-`u32` bins buffer and a
//! `MAPLE_SCOPE_SNAPSHOT_MAX_DIM² × 3`-byte snapshot buffer and pass their
//! pointers in `bins_ptr`/`bins_len` and `snapshot_ptr`/`snapshot_len`
//! alongside this small fixed struct; the FFI writes `frame`/`total`/the
//! buffers only when a sample landed (`frame` stays whatever the host last
//! saw otherwise — the render call did not skip the write, there was simply
//! nothing new to report yet).

/// Long-edge clamp of the RGB snapshot a scope sample carries (#3251) —
/// the host sizes `snapshot_ptr`'s buffer at `MAX_DIM² × 3` bytes. Equal
/// to `raw_core::scope::SCOPE_SNAPSHOT_MAX_DIM` (pinned by test below;
/// spelled as a literal so cbindgen emits the `#define`).
pub const MAPLE_SCOPE_SNAPSHOT_MAX_DIM: u32 = 512;

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
///
/// `snapshot_ptr` (#3251) is the same host-owns-the-buffer shape for the
/// downsampled RGB8 snapshot of the frame the bins describe — the Apple
/// twin of the web worker's `readbackScopeSnapshot`. The FFI writes
/// `snapshot_width`/`snapshot_height` on every landed sample: the real
/// dims when the packed `3 × w × h` bytes were copied into the host
/// buffer, `0 × 0` when they weren't (null `snapshot_ptr`, or a
/// `snapshot_len` too small) — so a host that reads non-zero dims can
/// trust the bytes behind them.
#[repr(C)]
pub struct MapleScopeStats {
    pub frame: u64,
    pub total: u32,
    pub _pad: u32,
    pub bins_ptr: *mut u32,
    pub bins_len: u32,
    pub snapshot_width: u32,
    pub snapshot_height: u32,
    pub snapshot_len: u32,
    pub snapshot_ptr: *mut u8,
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

/// Write the snapshot (#3251) into `out`'s caller-owned buffer, same
/// null-`out` no-op contract as [`write_stats`]. The dims land either way
/// (see the struct doc): the real ones after a copy, zero without one.
pub(crate) fn write_snapshot(out: *mut MapleScopeStats, width: u32, height: u32, rgb: &[u8]) {
    if out.is_null() {
        return;
    }
    // SAFETY: as `write_stats` — `out` is a live host-owned struct and
    // `snapshot_ptr` (if non-null) points at `snapshot_len` writable bytes
    // for the duration of the call.
    unsafe {
        let ptr = (*out).snapshot_ptr;
        let len = (*out).snapshot_len as usize;
        let copied = !ptr.is_null() && len >= rgb.len() && !rgb.is_empty();
        if copied {
            std::ptr::copy_nonoverlapping(rgb.as_ptr(), ptr, rgb.len());
        }
        (*out).snapshot_width = if copied { width } else { 0 };
        (*out).snapshot_height = if copied { height } else { 0 };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_clamp_matches_raw_core() {
        assert_eq!(
            MAPLE_SCOPE_SNAPSHOT_MAX_DIM,
            raw_core::scope::SCOPE_SNAPSHOT_MAX_DIM
        );
    }

    fn stats(buf: Option<&mut [u8]>) -> MapleScopeStats {
        let (ptr, len) = match buf {
            Some(b) => (b.as_mut_ptr(), b.len() as u32),
            None => (std::ptr::null_mut(), 0),
        };
        MapleScopeStats {
            frame: 0,
            total: 0,
            _pad: 0,
            bins_ptr: std::ptr::null_mut(),
            bins_len: 0,
            snapshot_width: 7,
            snapshot_height: 7,
            snapshot_len: len,
            snapshot_ptr: ptr,
        }
    }

    #[test]
    fn snapshot_dims_only_claim_bytes_that_were_copied() {
        let rgb = [1u8, 2, 3, 4, 5, 6];
        let mut big = [0u8; 6];
        let mut s = stats(Some(&mut big));
        write_snapshot(&mut s, 2, 1, &rgb);
        assert_eq!((s.snapshot_width, s.snapshot_height), (2, 1));
        assert_eq!(big, rgb);

        let mut small = [0u8; 3];
        let mut s = stats(Some(&mut small));
        write_snapshot(&mut s, 2, 1, &rgb);
        assert_eq!((s.snapshot_width, s.snapshot_height), (0, 0));
        assert_eq!(small, [0, 0, 0], "a too-small buffer is never written");

        let mut s = stats(None);
        write_snapshot(&mut s, 2, 1, &rgb);
        assert_eq!((s.snapshot_width, s.snapshot_height), (0, 0));

        write_snapshot(std::ptr::null_mut(), 2, 1, &rgb);
    }
}

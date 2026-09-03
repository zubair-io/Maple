//! The C-visible vectorscope statistics block (#3272, spec §5.4). Hosts own
//! the allocation (65,552 bytes: `8 (frame) + 4 (total) + 4 (padding) +
//! 128*128*4 (bins)`) and pass a pointer per render/present call; the FFI
//! writes it only when a sample landed (`frame` stays whatever the host last
//! saw otherwise — the render call did not skip the write, there was simply
//! nothing new to report yet).

/// `bins` is row-major `[cr][cb]`, 128×128, in `raw_core::scope::WEIGHT_SCALE`
/// (1/255) fixed point; `total` is the summed weight in the same fixed
/// point; `frame` is the GPU session's own monotonic counter (see
/// `raw_gpu::ScopeStats`) — it increments per render tick with the scope
/// enabled, NOT per call to this write, so the host can tell a genuinely
/// fresh sample from the same one seen last call (unwritten across a call =
/// unchanged `frame`).
#[repr(C)]
pub struct MapleScopeStats {
    pub frame: u64,
    pub total: u32,
    pub _pad: u32,
    // 128 * 128 (Rec.709 Cb/Cr histogram bins) — written as the literal
    // 16384, not the multiplication, because cbindgen can't resolve a
    // computed array-length expression: it silently falls back to emitting
    // this whole struct as an OPAQUE forward declaration in the generated
    // C header (`typedef struct MapleScopeStats MapleScopeStats;`, no
    // field body at all), which compiles fine on the Rust side but leaves
    // every C/Swift caller unable to read a single field. Caught by
    // actually regenerating the header and grepping for the struct body
    // (#3277) — this is exactly the kind of divergence `cargo test` cannot
    // see, since it never touches cbindgen's output.
    pub bins: [u32; 16384],
}

/// Write `(frame, total, bins)` into `out` if non-null. A null `out` is the
/// "the host didn't ask for scope stats on this call" case (mirrors every
/// other optional output pointer in this crate) — silently a no-op, not an
/// error.
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
    // it owns for the duration of this call — the same contract every other
    // FFI entry's output pointer carries.
    unsafe {
        (*out).frame = frame;
        (*out).total = total;
        (*out).bins.copy_from_slice(bins);
    }
}

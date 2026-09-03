//! The vectorscope scope pass host side (#3272): encode the histogram kernel
//! over a chain buffer into a `(BINS² + 1) × u32` buffer. Not a [`crate::chain::Pass`]
//! — it reads the FINAL chain buffer (after the view tail) without producing
//! a `dst`, so it doesn't fit the ping-pong `Pass` shape every other stage
//! uses; [`LiveSession`](crate::LiveSession) and the headless callers invoke
//! [`encode_vectorscope`] directly instead.

use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// Grid side length of the vectorscope histogram. Mirrored from
/// `raw_core::scope::VECTORSCOPE_BINS`; this crate takes raw-core only as a
/// dev-dependency (see `Cargo.toml`), so its real, non-test API cannot name
/// that constant directly — the parity test in `scope/tests.rs` pins the two
/// together, the same way `local_adjustments.rs`'s `LAYER_FLAT_LEN` is
/// pinned against raw-core's constant.
pub const VECTORSCOPE_BINS: usize = 128;

/// Byte length of the histogram buffer: `BINS²` bins plus the trailing total.
pub const SCOPE_HIST_BYTE_LEN: u64 = ((VECTORSCOPE_BINS * VECTORSCOPE_BINS + 1) * 4) as u64;

/// One scope sample, unpacked from the mapped histogram buffer.
#[derive(Clone, Debug, PartialEq)]
pub struct ScopeStats {
    /// Row-major `[cr_bin][cb_bin]`, `VECTORSCOPE_BINS²` entries — same
    /// layout as `raw_core::scope::VectorscopeHistogram::bins`.
    pub bins: Vec<u32>,
    pub total: u32,
    /// Monotonic per session, starting at 1 for the first tick a sample was
    /// encoded on; the host uses it to notice a stale (already-seen) sample.
    pub frame: u64,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    bins: u32,
    use_alpha: u32,
    _pad0: u32,
}

/// Zero `hist` and accumulate `src` (RGBA f32, `count` pixels) into it.
/// `use_alpha` selects the weight source: the alpha lane (a scope-target
/// layer's recorded weight — see `local_adjustments.wgsl`) when `true`, or
/// weight 1 everywhere (the whole-frame scope) when `false`.
pub fn encode_vectorscope(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    hist: &wgpu::Buffer,
    count: u32,
    use_alpha: bool,
) {
    encoder.clear_buffer(hist, 0, None);
    let params = Params {
        count,
        bins: VECTORSCOPE_BINS as u32,
        use_alpha: use_alpha as u32,
        _pad0: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.vectorscope_pipeline(),
        bytemuck::bytes_of(&params),
        &[src, hist],
        count,
        "scope-vectorscope",
    );
}

/// Unpack a mapped histogram buffer (`words.len() == BINS² + 1`, the
/// [`SCOPE_HIST_BYTE_LEN`]-sized `u32` view) into [`ScopeStats`].
pub fn unpack_scope(words: &[u32], frame: u64) -> ScopeStats {
    let n = VECTORSCOPE_BINS * VECTORSCOPE_BINS;
    ScopeStats {
        bins: words[..n].to_vec(),
        total: words[n],
        frame,
    }
}

/// Headless, blocking helper for tests: encode + submit + map a ONE-SHOT
/// vectorscope dispatch over `src` (already a GPU-resident RGBA f32 buffer)
/// and return the unpacked stats. Not for the live path — [`LiveSession`]
/// never blocks on a map; see `live_session/scope.rs`.
#[cfg(test)]
pub(crate) fn run_vectorscope_blocking(
    ctx: &GpuContext,
    src: &wgpu::Buffer,
    count: u32,
    use_alpha: bool,
) -> ScopeStats {
    let hist = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("scope-test-hist"),
        size: SCOPE_HIST_BYTE_LEN,
        // COPY_DST: `encode_vectorscope` clears this buffer before each
        // dispatch (`clear_buffer` needs it, same as an ordinary copy dst).
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let staging = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("scope-test-staging"),
        size: SCOPE_HIST_BYTE_LEN,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("scope-test-encoder"),
        });
    encode_vectorscope(ctx, &mut encoder, src, &hist, count, use_alpha);
    encoder.copy_buffer_to_buffer(&hist, 0, &staging, 0, SCOPE_HIST_BYTE_LEN);
    ctx.queue.submit(Some(encoder.finish()));

    let slice = staging.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    ctx.device.poll(wgpu::Maintain::Wait);
    pollster::block_on(rx)
        .expect("map_async channel dropped")
        .expect("map_async failed");
    let words: Vec<u32> = bytemuck::cast_slice(&slice.get_mapped_range()).to_vec();
    staging.unmap();
    unpack_scope(&words, 1)
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors `local_adjustments.rs`'s own split). Native test builds
// only — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "scope/tests.rs"]
mod tests;

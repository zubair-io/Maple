//! The scope passes' host side (#3272, #3251): encode the vectorscope
//! histogram kernel over a chain buffer into a `(BINS² + 1) × u32` buffer,
//! and the snapshot kernel into a packed-RGB8 `u32` buffer. Neither is a
//! [`crate::chain::Pass`] — both read the FINAL chain buffer (after the view
//! tail) without producing a `dst`, so they don't fit the ping-pong `Pass`
//! shape every other stage uses; [`LiveSession`](crate::LiveSession) and the
//! headless callers invoke [`encode_vectorscope`] / [`encode_snapshot`]
//! directly instead.

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

/// Long-edge clamp of the RGB snapshot (#3251). Mirrored from
/// `raw_core::scope::SCOPE_SNAPSHOT_MAX_DIM` for the same dev-dependency
/// reason as [`VECTORSCOPE_BINS`]; pinned by `scope/tests.rs`.
pub const SCOPE_SNAPSHOT_MAX_DIM: u32 = 512;

/// Byte length of the snapshot buffer: one packed-RGB8 `u32` per output cell
/// at the largest dims the clamp allows.
pub const SCOPE_SNAPSHOT_BYTE_LEN: u64 =
    (SCOPE_SNAPSHOT_MAX_DIM as u64) * (SCOPE_SNAPSHOT_MAX_DIM as u64) * 4;

/// Layout of one staging slot: the histogram words, then the snapshot words.
pub const SCOPE_STAGING_BYTE_LEN: u64 = SCOPE_HIST_BYTE_LEN + SCOPE_SNAPSHOT_BYTE_LEN;

/// The downsampled RGB8 snapshot of the frame a scope sample describes
/// (#3251) — `raw_core::scope::ScopeSnapshot`'s shape: packed row-major
/// RGB, `3 * width * height` bytes. Empty (`0 × 0`) when the sample was
/// unpacked without a snapshot region (the headless histogram-only helper).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeSnapshot {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// One scope sample, unpacked from the mapped staging buffer.
#[derive(Clone, Debug, PartialEq)]
pub struct ScopeStats {
    /// Row-major `[cr_bin][cb_bin]`, `VECTORSCOPE_BINS²` entries — same
    /// layout as `raw_core::scope::VectorscopeHistogram::bins`.
    pub bins: Vec<u32>,
    pub total: u32,
    /// Monotonic per session, starting at 1 for the first tick a sample was
    /// encoded on; the host uses it to notice a stale (already-seen) sample.
    pub frame: u64,
    /// The same tick's downsampled frame (#3251).
    pub snapshot: ScopeSnapshot,
}

/// `raw_core::scope::snapshot_dims`, mirrored (dev-dependency; pinned by
/// `scope/tests.rs`): unchanged when the long edge fits, else both edges
/// rounded down to the clamp, never below 1; an empty frame stays empty.
pub fn snapshot_dims(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (0, 0);
    }
    let long = width.max(height) as u64;
    if long <= SCOPE_SNAPSHOT_MAX_DIM as u64 {
        return (width, height);
    }
    let scale = |v: u32| -> u32 {
        let n = v as u64 * SCOPE_SNAPSHOT_MAX_DIM as u64;
        (((n + long / 2) / long) as u32).max(1)
    };
    (scale(width), scale(height))
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct SnapshotParams {
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
}

/// Box-mean `src` (RGBA f32, `src_dims`) into `out` (one packed-RGB8 `u32`
/// per cell, at least [`SCOPE_SNAPSHOT_BYTE_LEN`] long) at
/// [`snapshot_dims`]`(src_dims)`, which is returned so the caller knows how
/// many words the dispatch wrote. A no-op for an empty frame.
pub fn encode_snapshot(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    out: &wgpu::Buffer,
    src_dims: (u32, u32),
) -> (u32, u32) {
    let (dst_w, dst_h) = snapshot_dims(src_dims.0, src_dims.1);
    let count = dst_w * dst_h;
    if count == 0 {
        return (dst_w, dst_h);
    }
    let params = SnapshotParams {
        src_w: src_dims.0,
        src_h: src_dims.1,
        dst_w,
        dst_h,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.scope_snapshot_pipeline(),
        bytemuck::bytes_of(&params),
        &[src, out],
        count,
        "scope-snapshot",
    );
    (dst_w, dst_h)
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

/// Unpack a mapped staging buffer — the `BINS² + 1` histogram words, then
/// `width × height` packed-RGB8 snapshot words (`snapshot_dims`; `(0, 0)`
/// for a histogram-only view of [`SCOPE_HIST_BYTE_LEN`] words) — into
/// [`ScopeStats`].
pub fn unpack_scope(words: &[u32], frame: u64, snapshot_dims: (u32, u32)) -> ScopeStats {
    let n = VECTORSCOPE_BINS * VECTORSCOPE_BINS;
    let (width, height) = snapshot_dims;
    let cells = (width as usize) * (height as usize);
    let mut rgb = Vec::with_capacity(cells * 3);
    for word in &words[n + 1..n + 1 + cells] {
        rgb.extend_from_slice(&[*word as u8, (*word >> 8) as u8, (*word >> 16) as u8]);
    }
    ScopeStats {
        bins: words[..n].to_vec(),
        total: words[n],
        frame,
        snapshot: ScopeSnapshot { width, height, rgb },
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
    unpack_scope(&words, 1, (0, 0))
}

/// Headless, blocking sibling of [`run_vectorscope_blocking`] for the
/// snapshot kernel (#3251): encode + submit + map a one-shot downsample of
/// `src` (`src_dims`) and return it unpacked.
#[cfg(test)]
pub(crate) fn run_snapshot_blocking(
    ctx: &GpuContext,
    src: &wgpu::Buffer,
    src_dims: (u32, u32),
) -> ScopeSnapshot {
    let out = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("scope-test-snapshot"),
        size: SCOPE_SNAPSHOT_BYTE_LEN,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let staging = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("scope-test-snapshot-staging"),
        size: SCOPE_SNAPSHOT_BYTE_LEN,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("scope-test-snapshot-encoder"),
        });
    let dims = encode_snapshot(ctx, &mut encoder, src, &out, src_dims);
    let used = (dims.0 as u64) * (dims.1 as u64) * 4;
    encoder.copy_buffer_to_buffer(&out, 0, &staging, 0, used);
    ctx.queue.submit(Some(encoder.finish()));

    let slice = staging.slice(..used);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    ctx.device.poll(wgpu::Maintain::Wait);
    pollster::block_on(rx)
        .expect("map_async channel dropped")
        .expect("map_async failed");
    let snapshot_words: Vec<u32> = bytemuck::cast_slice(&slice.get_mapped_range()).to_vec();
    staging.unmap();
    // Reuse the shared unpacker on a synthetic staging view: zero histogram
    // words ahead of the snapshot words, exactly the live layout.
    let mut words = vec![0u32; VECTORSCOPE_BINS * VECTORSCOPE_BINS + 1];
    words.extend_from_slice(&snapshot_words);
    unpack_scope(&words, 1, dims).snapshot
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors `local_adjustments.rs`'s own split). Native test builds
// only — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "scope/tests.rs"]
mod tests;

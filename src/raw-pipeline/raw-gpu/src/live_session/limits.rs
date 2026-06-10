//! The #1079 containment cluster for [`LiveSession`](super::LiveSession), split
//! out of `live_session.rs` (600-LOC file budget): device-limit dim validation
//! (overflow-checked `w · h · 16` size math + descriptive error construction)
//! and the fallible readback maps — every helper that turns a would-be wgpu
//! validation panic into an `Err` hosts can surface (and CPU-fallback on).
//! Pure relocation; no behavior change.

use crate::context::GpuContext;

/// Validate `width × height` against `ctx`'s device limits (#1079). Checked
/// BEFORE any buffer allocation, so rejecting an absurd size is cheap. The
/// session's largest single binding is the whole-image RGBA f32 buffer
/// (`w · h · 16` bytes); it must fit both the storage-binding and the
/// buffer-size ceilings.
pub(super) fn validate_dims(ctx: &GpuContext, width: u32, height: u32) -> Result<u64, String> {
    if width == 0 || height == 0 {
        return Err(format!("LiveSession: zero dimension {width}x{height}"));
    }
    let f32_byte_len = (width as u64)
        .checked_mul(height as u64)
        .and_then(|px| px.checked_mul(4 * std::mem::size_of::<f32>() as u64))
        .ok_or_else(|| format!("LiveSession: pixel-count overflow {width}x{height}"))?;
    let limits = ctx.device.limits();
    if f32_byte_len > limits.max_storage_buffer_binding_size as u64 {
        return Err(format!(
            "LiveSession: image {width}x{height} needs a {f32_byte_len}-byte storage \
             binding, over the device's max_storage_buffer_binding_size {} — render at \
             a smaller size or fall back to the CPU path",
            limits.max_storage_buffer_binding_size
        ));
    }
    if f32_byte_len > limits.max_buffer_size {
        return Err(format!(
            "LiveSession: image {width}x{height} needs a {f32_byte_len}-byte buffer, \
             over the device's max_buffer_size {} — render at a smaller size or fall \
             back to the CPU path",
            limits.max_buffer_size
        ));
    }
    Ok(f32_byte_len)
}

/// Map the packed-u32 readback staging buffer and cast it to `Vec<u32>`. Native
/// polls the queue; wasm awaits the browser-driven map. Mirrors
/// `chain::map_readback_async` but for the u32 surface (not f32). A failed map
/// is an `Err`, not a panic (#1079).
#[cfg_attr(target_arch = "wasm32", allow(unused_variables))]
pub(super) async fn map_packed_readback(
    ctx: &GpuContext,
    readback: &wgpu::Buffer,
) -> Result<Vec<u32>, String> {
    let slice = readback.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    #[cfg(not(target_arch = "wasm32"))]
    ctx.device.poll(wgpu::Maintain::Wait);
    rx.await
        .map_err(|_| "live-session readback: map channel dropped".to_string())?
        .map_err(|e| format!("live-session readback: buffer map failed: {e}"))?;
    let data = slice.get_mapped_range();
    let out: Vec<u32> = bytemuck::cast_slice(&data).to_vec();
    drop(data);
    readback.unmap();
    Ok(out)
}

/// Map the f32 mid-chain readback staging buffer (the post-prefix buffer, C5a)
/// and cast it to `Vec<f32>` for `compute_airlight`. The f32 sibling of
/// [`map_packed_readback`].
#[cfg_attr(target_arch = "wasm32", allow(unused_variables))]
pub(super) async fn map_f32_readback(
    ctx: &GpuContext,
    readback: &wgpu::Buffer,
) -> Result<Vec<f32>, String> {
    let slice = readback.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    #[cfg(not(target_arch = "wasm32"))]
    ctx.device.poll(wgpu::Maintain::Wait);
    rx.await
        .map_err(|_| "live-session airlight readback: map channel dropped".to_string())?
        .map_err(|e| format!("live-session airlight readback: buffer map failed: {e}"))?;
    let data = slice.get_mapped_range();
    let out: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
    drop(data);
    readback.unmap();
    Ok(out)
}

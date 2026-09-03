//! Scope readback for [`LiveSession`] (#3272): the histogram buffer, a pair
//! of `MAP_READ` staging buffers, and the one-tick-late, never-blocking
//! [`LiveSession::take_scope_stats`]. Sibling file so `live_session.rs`
//! stays under the 600-line budget.
//!
//! ## Why one tick late
//!
//! `map_async` doesn't resolve inside the same tick it's requested — the
//! device needs to actually finish the copy first, and `LiveSession` never
//! blocks a render on that (the whole point of the live path is a bounded
//! per-tick cost). So each render REQUESTS a map for the sample it just
//! produced, and [`LiveSession::take_scope_stats`] reports the map that
//! completed by then — the PREVIOUS tick's. Two staging slots, alternating,
//! is what lets tick N's request and tick N-1's map coexist without either
//! blocking the other: while slot A is still mapping (or waiting to be
//! read), slot B is free to receive tick N's copy.

use super::LiveSession;
use crate::context::GpuContext;
use crate::scope::{unpack_scope, ScopeStats, SCOPE_HIST_BYTE_LEN};
use futures_channel::oneshot;
use std::cell::{Cell, RefCell};

/// Session-owned scope state. `Cell`/`RefCell` because every render method
/// takes `&self` (the session is single-threaded around the GPU, like every
/// other `LiveSession` buffer).
pub(super) struct ScopeBuffers {
    hist: wgpu::Buffer,
    staging: [wgpu::Buffer; 2],
    /// Which staging slot the NEXT tick's copy lands in.
    slot: Cell<usize>,
    /// Per slot: the frame number tagging the pending `map_async`, and its
    /// receiver. `None` = nothing pending in that slot.
    pending: RefCell<[Option<(u64, oneshot::Receiver<Result<(), wgpu::BufferAsyncError>>)>; 2]>,
    frame: Cell<u64>,
}

impl ScopeBuffers {
    pub(super) fn new(ctx: &GpuContext) -> Self {
        let hist = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live-scope-hist"),
            size: SCOPE_HIST_BYTE_LEN,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let staging = [0, 1].map(|i| {
            ctx.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(if i == 0 {
                    "live-scope-staging-a"
                } else {
                    "live-scope-staging-b"
                }),
                size: SCOPE_HIST_BYTE_LEN,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        });
        Self {
            hist,
            staging,
            slot: Cell::new(0),
            pending: RefCell::new([None, None]),
            frame: Cell::new(0),
        }
    }
}

impl LiveSession {
    /// Called by the chain encoders AFTER the chain passes are encoded and
    /// BEFORE submit: histogram `chain_buf`, copy it into this tick's staging
    /// slot. The map is requested right after the caller's submit, via
    /// [`Self::scope_after_submit`].
    pub(super) fn encode_scope(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        chain_buf: &wgpu::Buffer,
        use_alpha: bool,
    ) {
        let dims = self.image.dims();
        let s = &self.scope;
        crate::scope::encode_vectorscope(
            ctx,
            encoder,
            chain_buf,
            &s.hist,
            dims.0 * dims.1,
            use_alpha,
        );
        encoder.copy_buffer_to_buffer(&s.hist, 0, &s.staging[s.slot.get()], 0, SCOPE_HIST_BYTE_LEN);
    }

    /// Request the async map of this tick's staging slot and advance the slot.
    /// A slot whose previous map was never taken is dropped first (a stale
    /// sample nobody read is worthless; the host only ever wants the newest).
    pub(super) fn scope_after_submit(&self) {
        let s = &self.scope;
        let slot = s.slot.get();
        let frame = s.frame.get() + 1;
        s.frame.set(frame);
        let mut pending = s.pending.borrow_mut();
        if pending[slot].take().is_some() {
            s.staging[slot].unmap();
        }
        let (tx, rx) = oneshot::channel();
        s.staging[slot]
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |res| {
                let _ = tx.send(res);
            });
        pending[slot] = Some((frame, rx));
        s.slot.set(1 - slot);
    }

    /// The previous tick's stats if its map has completed, without blocking:
    /// polls the device once (`Maintain::Poll`), then checks the receiver.
    /// `None` until a render has been encoded with the scope enabled, or
    /// while the map is still in flight (try again after the next render).
    ///
    /// Reads slot `s.slot.get()` — NOT the slot the most recent
    /// [`Self::scope_after_submit`] call just wrote to (that one is `1 -
    /// s.slot.get()`, since that call flips the slot after writing). The
    /// point of alternating slots is to give a request a WHOLE tick's worth
    /// of wall-clock time before anything checks it — reading the
    /// just-written slot instead would check a map that was requested
    /// moments ago and is essentially never done yet, making this always
    /// return `None` under realistic timing.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn take_scope_stats(&self, ctx: &GpuContext) -> Option<ScopeStats> {
        let s = &self.scope;
        let prev = s.slot.get();
        let mut pending = s.pending.borrow_mut();
        let (frame, mut rx) = pending[prev].take()?;
        ctx.device.poll(wgpu::Maintain::Poll);
        match rx.try_recv() {
            Ok(Some(Ok(()))) => {
                let buf = &s.staging[prev];
                let words: Vec<u32> =
                    bytemuck::cast_slice(&buf.slice(..).get_mapped_range()).to_vec();
                buf.unmap();
                Some(unpack_scope(&words, frame))
            }
            Ok(None) => {
                // Still in flight — put it back so the next call can retry.
                pending[prev] = Some((frame, rx));
                None
            }
            _ => None, // channel dropped, or the map itself errored: skip this sample
        }
    }
}

use super::FramePool;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FramePosition {
    dispatch: usize,
    scratch: usize,
    digest: u64,
}

impl FramePool {
    // Counted like a pool miss, so the zero-allocation gate would see a tick that created the plane.
    pub(crate) fn create_resume_plane(&self, device: &wgpu::Device, bytes: u64) -> wgpu::Buffer {
        self.alloc_count.set(self.alloc_count.get() + 1);
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live-session-resume-cut"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }
    pub(crate) fn position(&self) -> FramePosition {
        FramePosition {
            dispatch: self.dispatch_cursor,
            scratch: self.scratch_cursor,
            digest: self.frame_digest,
        }
    }
    pub(crate) fn can_resume_at(&self, position: FramePosition) -> bool {
        self.frame_active
            && !self.in_detached
            && self.dispatch_cursor == 0
            && self.scratch_cursor == 0
            && self.buckets.get(&self.current_sig).is_some_and(|bucket| {
                bucket.dispatches.len() >= position.dispatch
                    && bucket.scratch.len() >= position.scratch
            })
    }
    pub(crate) fn resume_at(&mut self, position: FramePosition) {
        debug_assert!(self.can_resume_at(position));
        self.dispatch_cursor = position.dispatch;
        self.scratch_cursor = position.scratch;
        self.frame_digest = position.digest;
    }
}

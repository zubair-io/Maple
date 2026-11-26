use crate::context::GpuContext;
use crate::frame_pool::FramePosition;
use crate::full_chain::FullChainInputs;
use crate::live_chain::PrefixKey;

// Live sessions are display-sized (a 6K canvas is about 325 MB); only a full-resolution one exceeds this, and it never stores.
const MAX_RESIDENT_BYTES: u64 = 512 << 20;

#[derive(Default)]
pub(super) struct ResumeCut {
    state: std::sync::Mutex<CutState>,
    #[cfg(test)]
    resumed: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    allocated: std::sync::atomic::AtomicU64,
}

#[derive(Default)]
struct CutState {
    key: PrefixKey,
    frame: u64,
    resident: Option<wgpu::Buffer>,
    stored: Option<StoredCut>,
    #[cfg(test)]
    max_bytes: Option<u64>,
}

impl CutState {
    fn max_bytes(&self) -> u64 {
        #[cfg(test)]
        {
            if let Some(bytes) = self.max_bytes {
                return bytes;
            }
        }
        MAX_RESIDENT_BYTES
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct CutFrame(u64);

#[derive(Clone, Copy)]
pub(super) struct StoredCut {
    // The ping-pong buffer the prefix output was in, so a resumed frame binds the same buffers as a full one.
    pub(super) index: usize,
    pub(super) position: FramePosition,
    frame: CutFrame,
    submitted: bool,
}

pub(super) enum CutPlan {
    Resume(StoredCut),
    Run { store: bool },
}

impl ResumeCut {
    fn lock(&self) -> std::sync::MutexGuard<'_, CutState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn plan(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        plane_bytes: u64,
    ) -> (CutFrame, CutPlan) {
        let mut state = self.lock();
        state.frame += 1;
        let frame = CutFrame(state.frame);
        let repeated = state.key.update(inputs);
        state.stored = state.stored.filter(|cut| repeated && cut.submitted);
        let plan = match state.stored {
            Some(cut)
                if state.resident.is_some()
                    && ctx.frame_pool.borrow().can_resume_at(cut.position) =>
            {
                #[cfg(test)]
                self.resumed
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                CutPlan::Resume(cut)
            }
            // Store only when the prefix repeated the last tick, so one-shot and prefix-moving renders never copy.
            _ => CutPlan::Run {
                store: repeated && plane_bytes <= state.max_bytes(),
            },
        };
        (frame, plan)
    }

    pub(super) fn encode_resume(&self, encoder: &mut wgpu::CommandEncoder, dst: &wgpu::Buffer) {
        let state = self.lock();
        debug_assert!(
            state.resident.is_some(),
            "plan resumes only with a resident image"
        );
        if let Some(resident) = state.resident.as_ref() {
            encoder.copy_buffer_to_buffer(resident, 0, dst, 0, dst.size());
        }
    }

    pub(super) fn encode_store(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        index: usize,
        frame: CutFrame,
    ) {
        let mut state = self.lock();
        let resident = state.resident.get_or_insert_with(|| {
            #[cfg(test)]
            self.allocated
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            ctx.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("live-session-resume-cut"),
                size: src.size(),
                usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        });
        encoder.copy_buffer_to_buffer(src, 0, resident, 0, src.size());
        state.stored = Some(StoredCut {
            index,
            position: ctx.frame_pool.borrow().position(),
            frame,
            submitted: false,
        });
    }

    pub(super) fn submitted(&self, frame: CutFrame) {
        if let Some(cut) = self.lock().stored.as_mut().filter(|cut| cut.frame == frame) {
            cut.submitted = true;
        }
    }

    pub(super) fn abandoned(&self, frame: CutFrame) {
        let mut state = self.lock();
        if state
            .stored
            .is_some_and(|cut| cut.frame == frame && !cut.submitted)
        {
            state.stored = None;
        }
    }

    pub(super) fn clear(&self) {
        let mut state = self.lock();
        state.key.clear();
        state.stored = None;
    }

    #[cfg(test)]
    pub(super) fn resumed(&self) -> u64 {
        self.resumed.load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(super) fn allocated(&self) -> u64 {
        self.allocated.load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(super) fn set_max_bytes(&self, bytes: u64) {
        self.lock().max_bytes = Some(bytes);
    }

    #[cfg(test)]
    pub(super) fn covers(bytes: u64) -> bool {
        bytes <= MAX_RESIDENT_BYTES
    }

    #[cfg(test)]
    pub(super) fn encode_read(&self, encoder: &mut wgpu::CommandEncoder, dst: &wgpu::Buffer) {
        let state = self.lock();
        let resident = state.resident.as_ref().expect("a stored image");
        encoder.copy_buffer_to_buffer(resident, 0, dst, 0, resident.size());
    }
}

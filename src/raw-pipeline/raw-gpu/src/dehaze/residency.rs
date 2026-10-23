use super::{encode_haze_map, encode_recover, AirlightSource, HazeMapPlanes};
use crate::context::GpuContext;

/// A live session's resident haze maps (#3287), one slot per dehaze stage.
/// A map depends only on the pixels its dehaze receives, so each is keyed by
/// the frame pool's digest of the kernels and inputs that produced them
/// (`FramePool::frame_digest`) plus the render dims; the session clears them
/// when its source image changes.
#[derive(Default)]
pub struct HazeResidency {
    slots: std::sync::Mutex<Vec<Option<ResidentHaze>>>,
    #[cfg(test)]
    measured: std::sync::atomic::AtomicU64,
}

struct ResidentHaze {
    key: (u64, (u32, u32)),
    planes: HazeMapPlanes,
    /// The `(dispatch, scratch)` pool span measuring the map occupies, which
    /// a reusing frame steps over to keep later stages on their cached slots.
    span: (usize, usize),
    /// The frame digest after measuring, which a reusing frame resumes from
    /// so a later layer's map keys the same whether this one was measured or
    /// reused.
    digest_after: u64,
}

impl HazeResidency {
    /// Forget the map; the next dehaze render measures again.
    pub fn clear(&self) {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// Drop the slots past `len`, so deleted layers release their maps.
    pub(crate) fn truncate(&self, len: usize) {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .truncate(len);
    }

    #[cfg(test)]
    pub(crate) fn slot_count(&self) -> usize {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    /// How many renders measured the map (test hook).
    #[cfg(test)]
    pub(crate) fn measured(&self) -> u64 {
        self.measured.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub(super) fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
        dehaze: f32,
        index: usize,
    ) {
        let key = (ctx.frame_pool.borrow().frame_digest(), dims);
        let mut slots = self
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slots.len() <= index {
            slots.resize_with(index + 1, || None);
        }
        let slot = &mut slots[index];
        let reused = slot
            .as_ref()
            .filter(|resident| {
                resident.key == key && ctx.frame_pool.borrow_mut().skip(resident.span)
            })
            .map(|resident| resident.digest_after);
        if let Some(digest_after) = reused {
            ctx.frame_pool.borrow_mut().resume_digest(digest_after);
        } else {
            let start = ctx.frame_pool.borrow().cursors();
            let measured = encode_haze_map(ctx, encoder, src, dims, &AirlightSource::OnGpu);
            let end = ctx.frame_pool.borrow().cursors();
            let digest_after = ctx.frame_pool.borrow().frame_digest();
            let resident = match slot.take() {
                Some(resident) if resident.planes.proxy == measured.proxy => resident.planes,
                _ => HazeMapPlanes::resident(ctx, measured.proxy),
            };
            for (from, to) in [
                (&measured.coefficients, &resident.coefficients),
                (&measured.sky, &resident.sky),
                (&measured.airlight, &resident.airlight),
            ] {
                encoder.copy_buffer_to_buffer(from, 0, to, 0, from.size());
            }
            *slot = Some(ResidentHaze {
                key,
                planes: resident,
                span: (end.0 - start.0, end.1 - start.1),
                digest_after,
            });
            #[cfg(test)]
            self.measured
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        let planes = &slot.as_ref().expect("measured above").planes;
        encode_recover(ctx, encoder, src, dst, dims, dehaze, planes);
    }
}

use super::{encode_haze_map, encode_recover, AirlightSource, HazeMapPlanes};
use crate::context::GpuContext;

/// Detached frame-pool bucket of slot 0's measurement; slot `i` uses `+ i`.
const DETACHED_BUCKET: u64 = 0x4841_5A45_0000_0000;

/// A live session's resident haze maps (#3287), one slot per dehaze stage.
/// A map depends only on the pixels its dehaze receives, so each is keyed by
/// the frame pool's digest of the kernels and inputs that produced them
/// (`FramePool::frame_digest`) plus the render dims; the session clears them
/// when its source image changes.
///
/// Measuring pools its resources in a detached bucket per slot, outside the
/// frame's own, so a frame that reuses the map leaves every later stage on
/// its cached slots and the frame digest unchanged, and a chain-signature
/// change (a downstream stage crossing its gate) keeps the map.
#[derive(Default)]
pub struct HazeResidency {
    slots: std::sync::Mutex<Vec<Option<ResidentHaze>>>,
    #[cfg(test)]
    measured: std::sync::atomic::AtomicU64,
}

struct ResidentHaze {
    /// `None` once the frame that measured the map was abandoned unsubmitted:
    /// its copies into `planes` never ran.
    key: Option<(u64, (u32, u32))>,
    planes: HazeMapPlanes,
    /// Whether the frame that measured the map was submitted.
    submitted: bool,
}

impl HazeResidency {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Option<ResidentHaze>>> {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Forget the map; the next dehaze render measures again.
    pub fn clear(&self) {
        self.lock().clear();
    }

    /// Drop the slots past `len`, so deleted layers release their maps.
    pub(crate) fn truncate(&self, len: usize) {
        self.lock().truncate(len);
    }

    /// The frame just encoded will be submitted: the maps it measured hold.
    pub(crate) fn submitted(&self) {
        self.lock()
            .iter_mut()
            .flatten()
            .for_each(|resident| resident.submitted = true);
    }

    /// The frame just encoded is dropped unsubmitted: forget the maps it
    /// measured, whose planes were never written.
    pub(crate) fn abandoned(&self) {
        self.lock()
            .iter_mut()
            .flatten()
            .filter(|resident| !resident.submitted)
            .for_each(|resident| resident.key = None);
    }

    #[cfg(test)]
    pub(crate) fn slot_count(&self) -> usize {
        self.lock().len()
    }

    /// How many renders measured the map (test hook).
    #[cfg(test)]
    pub(crate) fn measured(&self) -> u64 {
        self.measured.load(std::sync::atomic::Ordering::Relaxed)
    }

    #[allow(clippy::too_many_arguments)]
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
        let key = Some((ctx.frame_pool.borrow().frame_digest(), dims));
        let mut slots = self.lock();
        if slots.len() <= index {
            slots.resize_with(index + 1, || None);
        }
        let slot = &mut slots[index];
        if !slot.as_ref().is_some_and(|resident| resident.key == key) {
            let saved = ctx
                .frame_pool
                .borrow_mut()
                .enter_detached(DETACHED_BUCKET + index as u64);
            let measured = encode_haze_map(ctx, encoder, src, dims, &AirlightSource::OnGpu);
            ctx.frame_pool.borrow_mut().leave_detached(saved);
            let planes = match slot.take() {
                Some(resident) if resident.planes.proxy == measured.proxy => resident.planes,
                _ => HazeMapPlanes::resident(ctx, measured.proxy),
            };
            for (from, to) in [
                (&measured.coefficients, &planes.coefficients),
                (&measured.sky, &planes.sky),
                (&measured.airlight, &planes.airlight),
            ] {
                encoder.copy_buffer_to_buffer(from, 0, to, 0, from.size());
            }
            *slot = Some(ResidentHaze {
                key,
                planes,
                submitted: false,
            });
            #[cfg(test)]
            self.measured
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        let planes = &slot.as_ref().expect("measured above").planes;
        encode_recover(ctx, encoder, src, dst, dims, dehaze, planes);
    }
}

//! Observes when the GPU has finished the work behind a published frame (#6043).
//! The worker publishes `GpuRendered` once a frame's commands are submitted, not
//! when the GPU has executed them (`LiveSession::render_chain_to_f32` and
//! `PresentTexture::present` only submit), so a latency stopped at that event is
//! a submission time. This registers a work-done callback on the same queue the
//! worker submits to. The callback covers every submission made before it was
//! registered, which can include the next tick's, so the time it reports is an
//! upper bound of the frame's own completion.
use eframe::egui_wgpu::wgpu;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Work-done callbacks only run when the device is polled. The poll never
/// waits: a waiting poll holds the device's fence lock, which `Queue::submit`
/// needs, so it would stall the worker's next submission behind the GPU's
/// current work and hide the backlog a real drag builds up.
const POLL_INTERVAL: Duration = Duration::from_micros(500);

pub struct CompletionWatch {
    queue: Arc<wgpu::Queue>,
    done: mpsc::Sender<(u64, Instant)>,
    arrivals: mpsc::Receiver<(u64, Instant)>,
    expected: HashSet<u64>,
    seen: HashMap<u64, Instant>,
    stop: Arc<AtomicBool>,
    poller: Option<JoinHandle<()>>,
}

impl CompletionWatch {
    pub fn new(ctx: &raw_gpu::GpuContext) -> Self {
        let (done, arrivals) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let device = ctx.device.clone();
        let poller = {
            let stop = stop.clone();
            std::thread::spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    device.poll(wgpu::Maintain::Poll);
                    std::thread::sleep(POLL_INTERVAL);
                }
            })
        };
        Self {
            queue: ctx.queue.clone(),
            done,
            arrivals,
            expected: HashSet::new(),
            seen: HashMap::new(),
            stop,
            poller: Some(poller),
        }
    }

    /// Call after the worker has submitted `generation`'s frame.
    pub fn expect(&mut self, generation: u64) {
        self.expected.insert(generation);
        let done = self.done.clone();
        self.queue.on_submitted_work_done(move || {
            let _ = done.send((generation, Instant::now()));
        });
    }

    /// When the GPU finished `generation`'s frame; `None` for a frame the GPU
    /// did not render (the worker fell back to the CPU renderer).
    pub fn completed(
        &mut self,
        generation: u64,
        timeout: Duration,
    ) -> Result<Option<Instant>, String> {
        if !self.expected.remove(&generation) {
            return Ok(None);
        }
        loop {
            if let Some(at) = self.seen.remove(&generation) {
                return Ok(Some(at));
            }
            match self.arrivals.recv_timeout(timeout) {
                Ok((arrived, at)) => {
                    self.seen.insert(arrived, at);
                }
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                    return Err("The GPU did not finish a published frame".to_owned());
                }
            }
        }
    }
}

impl Drop for CompletionWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(poller) = self.poller.take() {
            let _ = poller.join();
        }
    }
}

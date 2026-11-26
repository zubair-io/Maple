//! Drives the application's own `Worker` as the editor does (#6043): open and
//! first frame, slider ticks paced at the display rate through the latest-wins
//! mailbox, and a profile switch superseded while in flight. It only observes
//! the events the worker publishes; the worker's scheduling is untouched.
//!
//! Covered: worker open to first published frame, tick-to-frame latency of an
//! Exposure and a Contrast drag, how many ticks were answered and the longest
//! stretch with no frame, the time to abandon a superseded profile switch, and
//! the process's peak resident memory. Not covered: the debounced quiet-refine
//! and detail pass, frame presentation after the worker event, saves on the
//! worker thread, input dispatch, and GPU memory.
use eframe::egui;
use maple_linux::controls::Control;
use maple_linux::jobs::{Command, Event, Worker};
use maple_linux::library::Photo;
use raw_core::types::adjustment::{AdjustmentModel, Profile};
use serde::Serialize;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

pub const TICK_RATE_HZ: u32 = 60;
const TICK_TARGET_MS: f64 = 16.0;
const TICK_CEILING_MS: f64 = 50.0;
const SESSION: u64 = 2;
/// A render for an image that is no longer open supersedes the in-flight
/// render like any newer tick, and is answered without rendering as soon as
/// the worker is free: the reply time is the cancellation latency alone.
const CLOSED_SESSION: u64 = 1;
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(600);
const STALLED: &str = "The worker published nothing for ten minutes";
const NATIVE_SIZE_TIMEOUT: Duration = Duration::from_secs(10);
const EXITED: &str = "The worker exited";
const MIN_PUBLISHED_FRAMES: u32 = 20;
const MIN_PUBLISHED_RATIO: f64 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
    /// Ticks sent per slider; at least one.
    pub ticks: u32,
    pub cancellations: u32,
}

impl Options {
    pub fn check(self) -> Result<Self, String> {
        (self.ticks > 0)
            .then_some(self)
            .ok_or_else(|| "At least one slider tick is required".to_owned())
    }
}

impl Default for Options {
    fn default() -> Self {
        Self {
            ticks: 120,
            cancellations: 5,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Renderer {
    GpuResident,
    Cpu,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Percentiles {
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

impl Percentiles {
    /// Nearest-rank percentiles of millisecond samples; `None` without samples.
    pub fn of(samples: &[f64]) -> Option<Self> {
        let mut sorted = samples.to_vec();
        sorted.sort_by(f64::total_cmp);
        let rank = |quantile: f64| {
            let position = (quantile * sorted.len() as f64).ceil() as usize;
            sorted[position.clamp(1, sorted.len()) - 1]
        };
        (!sorted.is_empty()).then(|| Self {
            p50_ms: rank(0.5),
            p95_ms: rank(0.95),
            max_ms: rank(1.0),
        })
    }
}

/// One slider drag. `published_ratio` and `worst_gap_ms` say how well the
/// worker kept up: every tick supersedes the render in flight, so a path slower
/// than a display interval answers few ticks and its percentiles describe few
/// frames. The first published frame is reported apart as `first_tick_ms` and
/// left out of the percentiles and counts, as it can carry one-off work.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickStats {
    #[serde(flatten)]
    pub latency: Option<Percentiles>,
    pub first_tick_ms: f64,
    pub over16: u32,
    pub over50: u32,
    pub published: u32,
    pub sent: u32,
    pub published_ratio: f64,
    pub worst_gap_ms: f64,
}

impl TickStats {
    /// `frames` are the published frames in arrival order, each with the index
    /// of the tick it answers; `None` when no frame was published.
    pub fn from_timeline(sent: &[Instant], frames: &[(usize, Instant)]) -> Option<Self> {
        let (&(first_tick, first_arrival), rest) = frames.split_first()?;
        let latencies: Vec<f64> = rest
            .iter()
            .map(|&(tick, arrival)| millis(arrival.duration_since(sent[tick])))
            .collect();
        let over = |limit: f64| latencies.iter().filter(|&&ms| ms > limit).count() as u32;
        let arrivals = frames.iter().map(|&(_, arrival)| arrival);
        let gaps = std::iter::once(sent[0])
            .chain(arrivals.clone())
            .zip(arrivals)
            .map(|(before, after)| millis(after.duration_since(before)));
        Some(Self {
            latency: Percentiles::of(&latencies),
            first_tick_ms: millis(first_arrival.duration_since(sent[first_tick])),
            over16: over(TICK_TARGET_MS),
            over50: over(TICK_CEILING_MS),
            published: frames.len() as u32,
            sent: sent.len() as u32,
            published_ratio: frames.len() as f64 / sent.len() as f64,
            worst_gap_ms: gaps.fold(0.0, f64::max),
        })
    }

    pub fn starved(&self) -> bool {
        self.published < MIN_PUBLISHED_FRAMES || self.published_ratio < MIN_PUBLISHED_RATIO
    }
}

/// A profile switch (which re-uploads the preview) superseded part-way through
/// by a render for a closed session: the time until the worker answers that
/// render, having dropped the switch. A sample whose switch finished first is
/// counted, not timed. Slider ticks superseded by the next tick publish no
/// event, so their cancellation is not observable and is not timed.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSwitchCancellation {
    pub switch_uninterrupted_ms: f64,
    pub samples: u32,
    pub completed_before_cancel: u32,
    #[serde(flatten)]
    pub latency: Option<Percentiles>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMeasurement {
    pub renderer: Renderer,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    pub profile: &'static str,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub cold_open_uncached_ms: f64,
    pub cold_open_decode_ms: f64,
    pub tick_exposure: TickStats,
    pub tick_contrast: TickStats,
    pub profile_switch_cancellation: ProfileSwitchCancellation,
    /// The process high-water mark when this path finished; it never falls,
    /// so a later path's value includes every earlier one.
    pub peak_resident_bytes: u64,
    /// The decoded image's width and height the worker reports, not the preview's.
    #[serde(skip)]
    pub native: (u32, u32),
}

enum Signal {
    Frame(u64),
    Idle(u64),
}

struct Driver {
    worker: Worker,
    generation: u64,
    cpu_frames: bool,
    dims: (u32, u32),
    native: Option<(u32, u32)>,
    fallback_reason: Option<String>,
}

/// Why a receive failed: the worker is gone, or published nothing in time.
pub fn lost(error: RecvTimeoutError) -> String {
    match error {
        RecvTimeoutError::Timeout => STALLED.to_owned(),
        RecvTimeoutError::Disconnected => EXITED.to_owned(),
    }
}

impl Driver {
    fn poll(&mut self, deadline: Option<Instant>) -> Result<Option<Signal>, String> {
        loop {
            let wait = deadline.map_or(PUBLISH_TIMEOUT, |deadline| {
                deadline.saturating_duration_since(Instant::now())
            });
            let event = match self.worker.events.recv_timeout(wait) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) if deadline.is_some() => return Ok(None),
                Err(error) => return Err(lost(error)),
            };
            match event {
                Event::GpuRendered(SESSION, generation, frame) => {
                    self.dims = frame.dims;
                    return Ok(Some(Signal::Frame(generation)));
                }
                Event::Rendered(SESSION, generation, Ok(image), _) => {
                    self.cpu_frames = true;
                    self.dims = (image.size[0] as u32, image.size[1] as u32);
                    return Ok(Some(Signal::Frame(generation)));
                }
                Event::Rendered(SESSION, _, Err(error), _) => return Err(error),
                Event::Rendered(CLOSED_SESSION, generation, Err(_), _) => {
                    return Ok(Some(Signal::Idle(generation)));
                }
                Event::NativeSize(SESSION, Some(size)) => self.native = Some(size),
                Event::GpuFallback(SESSION, _, reason) => self.fallback_reason = Some(reason),
                _ => {}
            }
        }
    }

    fn request(&mut self, session: u64, model: &AdjustmentModel) -> u64 {
        self.generation += 1;
        self.worker
            .send(Command::Render(session, self.generation, model.clone()));
        self.generation
    }

    fn publish(&mut self, model: &AdjustmentModel) -> Result<Duration, String> {
        let sent = Instant::now();
        let generation = self.request(SESSION, model);
        loop {
            if let Some(Signal::Frame(published)) = self.poll(None)? {
                if published == generation {
                    return Ok(sent.elapsed());
                }
            }
        }
    }

    /// Records every tick frame published before `deadline`; without one,
    /// waits for the frame of the last tick sent.
    fn observe(
        &mut self,
        deadline: Option<Instant>,
        first: u64,
        frames: &mut Vec<(usize, Instant)>,
    ) -> Result<(), String> {
        loop {
            match self.poll(deadline)? {
                None => return Ok(()),
                Some(Signal::Frame(generation)) if generation >= first => {
                    frames.push(((generation - first) as usize, Instant::now()));
                    if deadline.is_none() && generation == self.generation {
                        return Ok(());
                    }
                }
                Some(_) => {}
            }
        }
    }

    /// One drag away from the resident value and back, a tick per display
    /// interval whether or not the previous frame was published.
    fn ticks(
        &mut self,
        resident: &AdjustmentModel,
        control: Control,
        count: u32,
    ) -> Result<TickStats, String> {
        let (min, max) = control.spec().range;
        let centre = control.get(resident);
        let reach = (max - min) * 0.1;
        let interval = Duration::from_secs(1) / TICK_RATE_HZ;
        let first = self.generation + 1;
        let mut model = resident.clone();
        let mut sent = Vec::with_capacity(count as usize);
        let mut frames = Vec::with_capacity(count as usize);
        let started = Instant::now();
        for tick in 0..count {
            self.observe(Some(started + interval * tick), first, &mut frames)?;
            let phase = (tick + 1) as f32 / count as f32;
            let value = centre + reach * (1.0 - (2.0 * phase - 1.0).abs());
            control.set(&mut model, value.clamp(min, max))?;
            sent.push(Instant::now());
            self.request(SESSION, &model);
        }
        self.observe(None, first, &mut frames)?;
        TickStats::from_timeline(&sent, &frames)
            .ok_or_else(|| "The worker published no frame for the drag".to_owned())
    }

    fn cancellation(
        &mut self,
        resident: &AdjustmentModel,
        samples: u32,
    ) -> Result<ProfileSwitchCancellation, String> {
        let switched = AdjustmentModel {
            profile: match resident.profile {
                Profile::Auto => Profile::Neutral,
                Profile::Neutral => Profile::Auto,
            },
            ..resident.clone()
        };
        let in_flight = self.publish(&switched)?;
        self.publish(resident)?;
        let mut latencies = Vec::with_capacity(samples as usize);
        for sample in 0..samples {
            let superseded = self.request(SESSION, &switched);
            std::thread::sleep(in_flight * (sample + 1) / (samples + 1));
            let cancelled = Instant::now();
            let probe = self.request(CLOSED_SESSION, &switched);
            let mut completed = false;
            let latency = loop {
                match self.poll(None)? {
                    Some(Signal::Frame(generation)) if generation == superseded => completed = true,
                    Some(Signal::Idle(generation)) if generation == probe => {
                        break cancelled.elapsed();
                    }
                    _ => {}
                }
            };
            if !completed {
                latencies.push(millis(latency));
            }
            // A switch stopped after its upload replaced the resident one publishes
            // no frame either; every sample starts from the resident profile again.
            self.publish(resident)?;
        }
        Ok(ProfileSwitchCancellation {
            switch_uninterrupted_ms: millis(in_flight),
            samples,
            completed_before_cancel: samples - latencies.len() as u32,
            latency: Percentiles::of(&latencies),
        })
    }
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn opened_model(worker: &Worker) -> Result<AdjustmentModel, String> {
    loop {
        match worker.events.recv_timeout(PUBLISH_TIMEOUT) {
            Ok(Event::Opened(SESSION, Ok((document, _)))) => return Ok(document.model.clone()),
            Ok(Event::Opened(SESSION, Err(error))) => return Err(error),
            Ok(_) => {}
            Err(error) => return Err(lost(error)),
        }
    }
}

pub fn peak_resident_bytes() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: `getrusage` writes the struct it is given; on failure it stays zeroed, which is valid.
    let usage = unsafe {
        libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
        usage.assume_init()
    };
    let unit = if cfg!(target_os = "macos") { 1 } else { 1024 };
    u64::try_from(usage.ru_maxrss).unwrap_or(0) * unit
}

/// Opens `photo` on a fresh worker and measures it: on the resident GPU path
/// with a context, on the CPU renderer the application falls back to without.
pub fn measure_path(
    photo: Photo,
    gpu: Option<raw_gpu::GpuContext>,
    options: Options,
) -> Result<PathMeasurement, String> {
    let options = options.check()?;
    let worker = Worker::with_gpu(egui::Context::default(), gpu);
    let started = Instant::now();
    worker.send(Command::Open(SESSION, photo));
    let resident = opened_model(&worker)?;
    let decoded = started.elapsed();
    worker.send(Command::NativeSize(SESSION));
    let mut driver = Driver {
        worker,
        generation: 0,
        cpu_frames: false,
        dims: (0, 0),
        native: None,
        fallback_reason: None,
    };
    driver.publish(&resident)?;
    let first_frame = started.elapsed();
    let native = loop {
        if let Some(size) = driver.native {
            break size;
        }
        if driver
            .poll(Some(Instant::now() + NATIVE_SIZE_TIMEOUT))?
            .is_none()
        {
            return Err("The worker did not report the image size".to_owned());
        }
    };
    let tick_exposure = driver.ticks(&resident, Control::Exposure, options.ticks)?;
    let tick_contrast = driver.ticks(&resident, Control::Contrast, options.ticks)?;
    let profile_switch_cancellation = driver.cancellation(&resident, options.cancellations)?;
    Ok(PathMeasurement {
        renderer: if driver.cpu_frames {
            Renderer::Cpu
        } else {
            Renderer::GpuResident
        },
        fallback_reason: driver.fallback_reason,
        profile: match resident.profile {
            Profile::Auto => "auto",
            Profile::Neutral => "neutral",
        },
        viewport_width: driver.dims.0,
        viewport_height: driver.dims.1,
        cold_open_uncached_ms: millis(first_frame),
        cold_open_decode_ms: millis(decoded),
        tick_exposure,
        tick_contrast,
        profile_switch_cancellation,
        peak_resident_bytes: peak_resident_bytes(),
        native,
    })
}

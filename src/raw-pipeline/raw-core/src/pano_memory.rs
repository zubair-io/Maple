//! The peak-memory model of a panorama stitch (#5454, #5555, #5891): what one costs, by phase.
//!
//! maple-pano refuses a stitch over its memory limit with these (#5835), and the Apple merge
//! sheet sizes the output with the same model through `tools/codegen.sh`, so neither carries
//! its own copy. No pixel-processing code reads them.
//!
//! A stitch peaks in one of two phases. The head (decode, matching, refinement) is set by
//! decoding the largest frame, which grows with its pixels: the file bytes, the decoded raw and
//! one develop's bands, or for X-Trans the whole developed frame (#6141 measured the two the
//! same on a 48 MP LinearRaw frame). Each frame adds only its proxy and features. The composite
//! holds a fixed floor, per-frame camera and photometry state, the largest frame's source taps,
//! a term proportional to the canvas's pixels (the seam and exposure canvases and the display
//! encoder scale with it, not only with the width its strips span) and per-thread strip and
//! allocator buffers.
//!
//! One model, two calibrations ([`PanoMemoryProfile`]), one for each place it is used, which
//! #6141 measured to the same constants:
//!
//! - [`PANO_MEMORY_SERVER`] is a guarantee: `maple-pano` refuses a stitch over the server's
//!   memory limit with it. It is fitted (#6141) to the whole-process peak footprint
//!   (`proc_pid_rusage`) of `maple-cli pano stitch --display` (the server's command; classical
//!   matcher, mesh local alignment) on a Mac (Mac17,6, 18 threads), per phase, over synthetic
//!   LinearRaw rings from 3 × 0.3 MP to 40 × 48 MP and the real pano_00 and pano_01, and
//!   checked against Linux's peak RSS of the same command at 4 to 64 threads (the tables in
//!   docs/pano.md, pinned by this module's tests). macOS's allocator keeps freed large blocks
//!   and counts them, so the Mac sets every constant and Linux sits further under it. Every
//!   constant rounds up, so each phase overstates every measurement.
//! - [`PANO_MEMORY_APPLE`] sizes the Apple merge sheet's output and refuses an over-limit stitch
//!   on the device. iOS and iPadOS run the Mac's allocator, and the Mac footprint covers the
//!   48 MP LinearRaw (ProRAW) frames the 2024 iPad calibration (#5555) never saw, so it is the
//!   server's. No device has been measured since #5450.
//!
//! The calibrations were measured at the default 1600 px proxy, so a frame's proxy costs at
//! least [`PANO_PROXY_PIXELS_MAX`] pixels' worth and a frame's own cost stops growing past
//! it. A configured proxy long edge above 1600 px retains a larger proxy per frame, and every
//! pixel past the fitted one costs at least its RGB f32 planes ([`PANO_PROXY_BYTES_PER_PIXEL`])
//! in both phases. The largest frame's width is taken as that of a 3:2 frame of its pixels
//! ([`frame_columns`]), the widest common sensor, so a 4:3 or portrait frame is overstated.
//! Every input frame counts, dropped or not, and each is costed as the largest.

/// One calibration of the model. With F frames, the largest of P pixels, its fitted proxy of
/// p = min(P, [`PANO_PROXY_PIXELS_MAX`]) pixels, its configured proxy of q ≥ p pixels (see
/// [`PanoStitchLoad::proxy_long_edge`]), its width c = [`frame_columns`]`(P)`, T worker threads
/// and a canvas of W × H pixels, a phase costs `fixed + F × (per_frame + p ×
/// per_frame_proxy_pixel + (q − p) × max(per_frame_proxy_pixel, PANO_PROXY_BYTES_PER_PIXEL)) +
/// P × per_largest_frame_pixel + c × per_largest_frame_column`, and the composite adds `W ×
/// per_canvas_column + W × H × per_canvas_pixel + T × per_thread`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PanoMemoryCalibration {
    pub head_bytes_fixed: u64,
    pub head_bytes_per_frame: u64,
    pub head_bytes_per_frame_proxy_pixel: u64,
    pub head_bytes_per_largest_frame_pixel: u64,
    pub head_bytes_per_largest_frame_column: u64,
    pub composite_bytes_fixed: u64,
    pub composite_bytes_per_frame: u64,
    pub composite_bytes_per_frame_proxy_pixel: u64,
    pub composite_bytes_per_largest_frame_pixel: u64,
    pub composite_bytes_per_largest_frame_column: u64,
    pub composite_bytes_per_canvas_column: u64,
    pub composite_bytes_per_canvas_pixel: u64,
    pub composite_bytes_per_thread: u64,
}

impl PanoMemoryCalibration {
    /// Every constant by name, for `tools/codegen.sh`.
    pub const fn fields(&self) -> [(&'static str, u64); 13] {
        [
            ("head_bytes_fixed", self.head_bytes_fixed),
            ("head_bytes_per_frame", self.head_bytes_per_frame),
            (
                "head_bytes_per_frame_proxy_pixel",
                self.head_bytes_per_frame_proxy_pixel,
            ),
            (
                "head_bytes_per_largest_frame_pixel",
                self.head_bytes_per_largest_frame_pixel,
            ),
            (
                "head_bytes_per_largest_frame_column",
                self.head_bytes_per_largest_frame_column,
            ),
            ("composite_bytes_fixed", self.composite_bytes_fixed),
            ("composite_bytes_per_frame", self.composite_bytes_per_frame),
            (
                "composite_bytes_per_frame_proxy_pixel",
                self.composite_bytes_per_frame_proxy_pixel,
            ),
            (
                "composite_bytes_per_largest_frame_pixel",
                self.composite_bytes_per_largest_frame_pixel,
            ),
            (
                "composite_bytes_per_largest_frame_column",
                self.composite_bytes_per_largest_frame_column,
            ),
            (
                "composite_bytes_per_canvas_column",
                self.composite_bytes_per_canvas_column,
            ),
            (
                "composite_bytes_per_canvas_pixel",
                self.composite_bytes_per_canvas_pixel,
            ),
            (
                "composite_bytes_per_thread",
                self.composite_bytes_per_thread,
            ),
        ]
    }
}

/// The server's calibration, a guarantee: fitted to the Mac's peak footprint, which covers
/// Linux's peak RSS (#6141).
pub const PANO_MEMORY_SERVER: PanoMemoryCalibration = PanoMemoryCalibration {
    head_bytes_fixed: 400 << 20,
    head_bytes_per_frame: 24 << 20,
    head_bytes_per_frame_proxy_pixel: 0,
    head_bytes_per_largest_frame_pixel: 32,
    head_bytes_per_largest_frame_column: 0,
    composite_bytes_fixed: 768 << 20,
    composite_bytes_per_frame: 16 << 20,
    composite_bytes_per_frame_proxy_pixel: 0,
    composite_bytes_per_largest_frame_pixel: 6,
    composite_bytes_per_largest_frame_column: 0,
    composite_bytes_per_canvas_column: 0,
    composite_bytes_per_canvas_pixel: 3,
    composite_bytes_per_thread: 8 << 20,
};

/// The Apple devices' calibration: the server's, since iOS and iPadOS run the Mac's allocator
/// (#6141).
pub const PANO_MEMORY_APPLE: PanoMemoryCalibration = PANO_MEMORY_SERVER;

/// Which calibration a stitch is costed with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanoMemoryProfile {
    /// `maple-pano`'s memory limit on the server (Linux).
    Server,
    /// The Apple merge sheet's output sizing (iOS, iPadOS, macOS).
    Apple,
}

impl PanoMemoryProfile {
    pub const fn calibration(self) -> &'static PanoMemoryCalibration {
        match self {
            Self::Server => &PANO_MEMORY_SERVER,
            Self::Apple => &PANO_MEMORY_APPLE,
        }
    }
}

/// A proxy's largest pixel count at the fitted (default) 1600 px long edge, square.
pub const PANO_PROXY_PIXELS_MAX: u64 = PANO_PROXY_FITTED_LONG_EDGE * PANO_PROXY_FITTED_LONG_EDGE;

/// The proxy long edge every calibration was measured at.
pub const PANO_PROXY_FITTED_LONG_EDGE: u64 = 1600;

/// A retained proxy's RGB f32 planes, per pixel.
pub const PANO_PROXY_BYTES_PER_PIXEL: u64 = 12;

/// ONNX Runtime with ALIKED and LightGlue loaded, on top of either phase. A two-frame stitch
/// on macOS CPU ONNX Runtime peaked at 4.65 GiB once the arena and memory pattern were off
/// (#1275), nearly all of it the runtime and the two models' weights; rounded up. The classical
/// matcher has no such floor, and iOS runs the models through CoreML, which this does not model.
pub const PANO_ML_RUNTIME_BYTES: u64 = 5 << 30;

/// The width of a 3:2 frame of `pixels`: the integer square root of 1.5 × `pixels`.
pub fn frame_columns(pixels: u64) -> u64 {
    let n = pixels.saturating_mul(3) / 2;
    let mut root = (n as f64).sqrt() as u64;
    while root.checked_mul(root).is_none_or(|sq| sq > n) {
        root -= 1;
    }
    while (root + 1).checked_mul(root + 1).is_some_and(|sq| sq <= n) {
        root += 1;
    }
    root
}

/// The frames a stitch works on, as far as its memory goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PanoStitchLoad {
    pub frame_count: u64,
    pub largest_frame_px: u64,
    /// The configured proxy long edge; one at or below the fitted 1600 px costs as the fitted.
    pub proxy_long_edge: u64,
    /// The worker threads the composite runs on (rayon's pool).
    pub threads: u64,
    pub ml_matcher: bool,
    pub profile: PanoMemoryProfile,
}

impl PanoStitchLoad {
    /// Peak of decode, matching and refinement.
    pub fn head_bytes(&self) -> u64 {
        let c = self.profile.calibration();
        self.phase_bytes(
            c.head_bytes_fixed,
            c.head_bytes_per_frame,
            c.head_bytes_per_frame_proxy_pixel,
            c.head_bytes_per_largest_frame_pixel,
            c.head_bytes_per_largest_frame_column,
        )
    }

    /// Peak of a preview. It holds what the head holds through matching (every frame's proxy
    /// and features, and one frame's banded develop at a time), then composites those same
    /// proxies onto a canvas of about 2 MP and never refines, so the head's terms bound it.
    pub fn preview_bytes(&self) -> u64 {
        self.head_bytes()
    }

    /// Peak of the composite onto a canvas of `canvas_width` × `canvas_height` pixels.
    pub fn composite_bytes(&self, canvas_width: u64, canvas_height: u64) -> u64 {
        let c = self.profile.calibration();
        let canvas = canvas_width
            .saturating_mul(c.composite_bytes_per_canvas_column)
            .saturating_add(
                canvas_width
                    .saturating_mul(canvas_height)
                    .saturating_mul(c.composite_bytes_per_canvas_pixel),
            )
            .saturating_add(self.threads.saturating_mul(c.composite_bytes_per_thread));
        self.phase_bytes(
            c.composite_bytes_fixed,
            c.composite_bytes_per_frame,
            c.composite_bytes_per_frame_proxy_pixel,
            c.composite_bytes_per_largest_frame_pixel,
            c.composite_bytes_per_largest_frame_column,
        )
        .saturating_add(canvas)
    }

    fn phase_bytes(
        &self,
        fixed: u64,
        per_frame: u64,
        per_proxy_px: u64,
        per_px: u64,
        per_column: u64,
    ) -> u64 {
        let runtime = if self.ml_matcher {
            PANO_ML_RUNTIME_BYTES
        } else {
            0
        };
        let fitted_proxy = self.largest_frame_px.min(PANO_PROXY_PIXELS_MAX);
        let proxy = self.largest_frame_px.min(
            self.proxy_long_edge
                .saturating_mul(self.proxy_long_edge)
                .max(PANO_PROXY_PIXELS_MAX),
        );
        let frame = per_frame
            .saturating_add(fitted_proxy.saturating_mul(per_proxy_px))
            .saturating_add(
                (proxy - fitted_proxy).saturating_mul(per_proxy_px.max(PANO_PROXY_BYTES_PER_PIXEL)),
            );
        self.frame_count
            .saturating_mul(frame)
            .saturating_add(self.largest_frame_px.saturating_mul(per_px))
            .saturating_add(frame_columns(self.largest_frame_px).saturating_mul(per_column))
            .saturating_add(fixed)
            .saturating_add(runtime)
    }
}

#[cfg(test)]
#[path = "pano_memory_tests.rs"]
mod tests;

//! The peak-memory model of a panorama stitch (#5454, #5555, #5891): what one costs, by phase.
//!
//! maple-pano refuses a stitch over its memory limit with these (#5835), and the Apple merge
//! sheet sizes the output with the same model through `tools/codegen.sh`, so neither carries
//! its own copy. No pixel-processing code reads them.
//!
//! A stitch peaks in one of two phases. The head (decode, matching, refinement) holds, per
//! frame, its proxy and the features, matches and solve state built from it, and for the largest
//! frame the banded decode: the raw mosaic, which grows with its pixels, and the develop bands,
//! which span its width. The composite still holds the per-frame state, plus what the allocator
//! kept of the decode, plus fixed-height strips whose buffers are output rows, so a term
//! proportional to canvas width.
//!
//! One model, two calibrations ([`PanoMemoryProfile`]), because the two allocators keep very
//! different amounts of freed memory:
//!
//! - [`PANO_MEMORY_SERVER`] is a guarantee: `maple-pano` refuses a stitch over the server's
//!   memory limit with it. It is fitted (#5891) to the whole-process peak footprint of
//!   `maple-cli pano stitch` (classical matcher, mesh local alignment) on a Mac (Mac17,6,
//!   18 threads), per phase, over 11 configurations (the table in docs/pano.md, pinned by this module's
//!   tests); every constant rounds up, so each phase
//!   overstates every measurement. macOS's allocator keeps freed large blocks and counts them
//!   (#5891 saw 386 MB of "Malloc Large (empty)" in the composite), so these overstate a Linux
//!   process; no Linux measurement has been made.
//! - [`PANO_MEMORY_APPLE`] sizes the Apple merge sheet's output. It is the #5555 calibration,
//!   unchanged: the iPad's pano_00 (3 × 100.7 MP, 12315 px wide) adds 1263 MiB in the head and
//!   593 MiB in the composite (#5450), about half what the Mac reports for the same stitch; the
//!   column term is the Mac's pano_01. Fitting it to the Mac would make an iPad with less than
//!   about 4 GB available refuse a 100 MP set it stitches today in about 1.7 GB.
//!
//! A frame's proxy is at most [`PANO_PROXY_PIXELS_MAX`] pixels, so a frame's own cost stops
//! growing past it. The largest frame's width is taken as that of a 3:2 frame of its pixels
//! ([`frame_columns`]), the widest common sensor, so a 4:3 or portrait frame is overstated.
//! Every input frame counts, dropped or not, and each is costed as the largest.

/// One calibration of the model. With F frames, the largest of P pixels, its proxy of
/// p = min(P, [`PANO_PROXY_PIXELS_MAX`]) pixels, its width c = [`frame_columns`]`(P)` and a
/// canvas W pixels wide, a phase costs `F × (per_frame + p × per_frame_proxy_pixel) +
/// P × per_largest_frame_pixel + c × per_largest_frame_column`, and the composite adds
/// `W × composite_bytes_per_canvas_column`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PanoMemoryCalibration {
    pub head_bytes_per_frame: u64,
    pub head_bytes_per_frame_proxy_pixel: u64,
    pub head_bytes_per_largest_frame_pixel: u64,
    pub head_bytes_per_largest_frame_column: u64,
    pub composite_bytes_per_frame: u64,
    pub composite_bytes_per_frame_proxy_pixel: u64,
    pub composite_bytes_per_largest_frame_pixel: u64,
    pub composite_bytes_per_largest_frame_column: u64,
    pub composite_bytes_per_canvas_column: u64,
}

impl PanoMemoryCalibration {
    /// Every constant by name, for `tools/codegen.sh`.
    pub const fn fields(&self) -> [(&'static str, u64); 9] {
        [
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
        ]
    }
}

/// The server's calibration, a guarantee: fitted to the Mac's peak footprint (#5891).
pub const PANO_MEMORY_SERVER: PanoMemoryCalibration = PanoMemoryCalibration {
    head_bytes_per_frame: 0,
    head_bytes_per_frame_proxy_pixel: 13,
    head_bytes_per_largest_frame_pixel: 0,
    head_bytes_per_largest_frame_column: 226_000,
    composite_bytes_per_frame: 40 << 20,
    composite_bytes_per_frame_proxy_pixel: 0,
    composite_bytes_per_largest_frame_pixel: 0,
    composite_bytes_per_largest_frame_column: 233_500,
    composite_bytes_per_canvas_column: 42_300,
};

/// The Apple merge sheet's calibration: the iPad's pano_00 and the Mac's pano_01 (#5555).
pub const PANO_MEMORY_APPLE: PanoMemoryCalibration = PanoMemoryCalibration {
    head_bytes_per_frame: 80 << 20,
    head_bytes_per_frame_proxy_pixel: 0,
    head_bytes_per_largest_frame_pixel: 12,
    head_bytes_per_largest_frame_column: 0,
    composite_bytes_per_frame: 80 << 20,
    composite_bytes_per_frame_proxy_pixel: 0,
    composite_bytes_per_largest_frame_pixel: 5,
    composite_bytes_per_largest_frame_column: 0,
    composite_bytes_per_canvas_column: 49_350,
};

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

/// A proxy's largest pixel count: the default 1600 px long edge, square.
pub const PANO_PROXY_PIXELS_MAX: u64 = 1600 * 1600;

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
    pub ml_matcher: bool,
    pub profile: PanoMemoryProfile,
}

impl PanoStitchLoad {
    /// Peak of decode, matching and refinement.
    pub fn head_bytes(&self) -> u64 {
        let c = self.profile.calibration();
        self.phase_bytes(
            c.head_bytes_per_frame,
            c.head_bytes_per_frame_proxy_pixel,
            c.head_bytes_per_largest_frame_pixel,
            c.head_bytes_per_largest_frame_column,
        )
    }

    /// Peak of the composite onto a canvas `canvas_width` pixels wide.
    pub fn composite_bytes(&self, canvas_width: u64) -> u64 {
        let c = self.profile.calibration();
        self.phase_bytes(
            c.composite_bytes_per_frame,
            c.composite_bytes_per_frame_proxy_pixel,
            c.composite_bytes_per_largest_frame_pixel,
            c.composite_bytes_per_largest_frame_column,
        )
        .saturating_add(canvas_width.saturating_mul(c.composite_bytes_per_canvas_column))
    }

    fn phase_bytes(&self, per_frame: u64, per_proxy_px: u64, per_px: u64, per_column: u64) -> u64 {
        let runtime = if self.ml_matcher {
            PANO_ML_RUNTIME_BYTES
        } else {
            0
        };
        let frame = per_frame.saturating_add(
            self.largest_frame_px
                .min(PANO_PROXY_PIXELS_MAX)
                .saturating_mul(per_proxy_px),
        );
        self.frame_count
            .saturating_mul(frame)
            .saturating_add(self.largest_frame_px.saturating_mul(per_px))
            .saturating_add(frame_columns(self.largest_frame_px).saturating_mul(per_column))
            .saturating_add(runtime)
    }
}

#[cfg(test)]
#[path = "pano_memory_tests.rs"]
mod tests;

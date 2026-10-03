//! Fit sizing for standalone and render-matched Auto Profile hosts (#4132).

/// The develop sampled by a host's one-shot Auto Profile calibration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FitCap {
    /// Existing standalone 1536px proxy (or a smaller embedded JPEG).
    Proxy,
    /// Native-resolution diagnostic; never cached or used by a host.
    Native,
    /// Match a bounded scene-linear decode's requested long edge. Zero is
    /// invalid. Artifacts use the same Render(size) cache key as the native
    /// sized renderer, separate from the standalone proxy. Calibration stays
    /// pinned to the default AE-off model regardless of caller edits.
    Render(u32),
}

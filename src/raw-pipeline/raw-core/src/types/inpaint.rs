//! Carrier for a baked synthetic-raw inpaint patch: scene-linear Rec.2020
//! pixels + a coverage (feather) mask, placed by normalized coordinates in the
//! full DefaultCrop image. Resolution-agnostic on purpose — the composite stage
//! resamples it onto whatever buffer size the render path is using
//! (viewport / full / tile). No I/O here (mirrors the `types` module contract).

/// A fixed-resolution inpaint patch in scene-linear Rec.2020.
#[derive(Clone, Debug, PartialEq)]
pub struct InpaintPatch {
    /// Patch native pixel dimensions.
    pub width: u32,
    pub height: u32,
    /// Top-left placement in normalized full-image coords, `[u, v]` in `[0, 1]`.
    pub origin: [f32; 2],
    /// Size in normalized full-image coords, `[du, dv]` in `(0, 1]`.
    pub extent: [f32; 2],
    /// Scene-linear Rec.2020 RGB, row-major, `len == width * height`.
    pub pixels: Vec<[f32; 3]>,
    /// Coverage / feather in `[0, 1]`, row-major, `len == width * height`.
    pub coverage: Vec<f32>,
}

impl InpaintPatch {
    /// True when dimensions are non-zero, extent positive, and both buffers
    /// have the declared length. A malformed patch is skipped by the compositor
    /// rather than panicking — a corrupt cache entry must not crash a render.
    pub fn is_valid(&self) -> bool {
        let n = (self.width as usize) * (self.height as usize);
        self.width > 0
            && self.height > 0
            && self.extent[0] > 0.0
            && self.extent[1] > 0.0
            && self.pixels.len() == n
            && self.coverage.len() == n
    }
}

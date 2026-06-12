//! `Crop` geometry type — normalised crop rect + straighten angle.
//!
//! Extracted from `mod.rs` to keep that file under the 600-LOC hard budget
//! (#772). Re-exported as `adjustment::Crop` via `pub use crop::Crop`.

/// Geometry (crop + straighten / rotate) per spec § 3.12.
///
/// All four edge fields are normalised to `[0, 1]` relative to the
/// display-oriented (post-EXIF orientation) image dimensions. Identity
/// (no-crop) is the full frame: `top=0, left=0, bottom=1, right=1, angle=0`.
/// The XMP boolean `crs:HasCrop` is derived — emitted only when
/// [`Crop::is_identity`] returns `false`.
///
/// `angle` is in degrees, positive = clockwise (reference-renderer
/// convention). The rotated-image-then-extract-rect math lives in
/// `stages::crop`. Exact 90 / 180 / 270 are taken when paired with the
/// matching orthogonal crop rect.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Crop {
    /// Top edge, normalised to `[0, 1]` of display-oriented image height.
    /// `0.0` = top of frame; `1.0` = bottom. Default (identity) = `0.0`.
    pub top: f32,
    /// Left edge, normalised to `[0, 1]` of display-oriented image width.
    /// Default (identity) = `0.0`.
    pub left: f32,
    /// Bottom edge, normalised to `[0, 1]`. Default (identity) = `1.0`.
    pub bottom: f32,
    /// Right edge, normalised to `[0, 1]`. Default (identity) = `1.0`.
    pub right: f32,
    /// Straighten rotation in degrees, positive = clockwise (reference-renderer
    /// convention). Default = `0.0`. Off-axis angles bilinear-resample; exact
    /// 90 / 180 / 270 are taken when paired with the matching orthogonal crop rect.
    pub angle: f32,
}

impl Crop {
    /// Identity crop: full frame, zero rotation. Equivalent to `Default::default()`
    /// but available in `const` contexts.
    pub const IDENTITY: Self = Self {
        top: 0.0,
        left: 0.0,
        bottom: 1.0,
        right: 1.0,
        angle: 0.0,
    };

    /// True iff this crop is the full-frame, zero-rotation identity. Used by
    /// the XMP serializer (omit the `crs:Crop*` group entirely) and by the
    /// `stages::crop` early-exit path so identity crops cost nothing.
    ///
    /// Equality is exact — defaults are concrete `0.0` / `1.0` literals that
    /// round-trip through XMP without drift.
    pub fn is_identity(&self) -> bool {
        self.top == 0.0
            && self.left == 0.0
            && self.bottom == 1.0
            && self.right == 1.0
            && self.angle == 0.0
    }

    /// True iff the rect (ignoring rotation) is well-formed: every edge in
    /// `[0, 1]`, `right > left`, `bottom > top`. Inverted or empty rects
    /// per spec § 3.12 are invalid; `stages::crop` treats them as identity.
    pub fn rect_is_valid(&self) -> bool {
        (0.0..=1.0).contains(&self.top)
            && (0.0..=1.0).contains(&self.left)
            && (0.0..=1.0).contains(&self.bottom)
            && (0.0..=1.0).contains(&self.right)
            && self.right > self.left
            && self.bottom > self.top
    }
}

impl Default for Crop {
    fn default() -> Self {
        Self::IDENTITY
    }
}

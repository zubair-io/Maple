//! The homography the seven manual-geometry sliders compose into (#3410),
//! and the parameter bundle that builds it.
//!
//! # Coordinate space
//!
//! Everything here works in **centred, half-extent-normalized** coordinates:
//! the frame is `[-1, 1] × [-1, 1]` with `(0, 0)` at the image centre and
//! `y` increasing downward. That choice is what lets one matrix serve both
//! render paths — the CPU tail converts pixel indices into it, the GPU
//! present shader converts texture UVs into it, and neither has to know the
//! other's convention. It also makes every slider resolution-independent by
//! construction: a keystone authored on a 100 MP frame lands the same
//! correction on a 12 MP preview of it.
//!
//! The one place the pixel aspect ratio has to re-enter is rotation, which
//! must stay circular rather than shearing on a non-square frame. The
//! rotation factor is therefore conjugated by `diag(ar, 1)` — see [`Matrices`].
//!
//! # Composition order
//!
//! `H = T · S · A · R · P`, read right-to-left as it applies to a source
//! point: keystone first (about the centre), then rotation, then the aspect
//! stretch, then uniform scale, then the offset. That is Adobe's order — the
//! offset moves the already-corrected frame, and scale magnifies the
//! keystone's transparent surround off-frame rather than being magnified by
//! it. Both would be visibly wrong the other way round.
//!
//! # Unit mapping
//!
//! Adobe does not document what one unit of `crs:PerspectiveVertical` means
//! geometrically, so the three constants below pin Maple's mapping. Sidecar
//! values round-trip unrescaled (a Lightroom `-20` loads as `-20`), and the
//! constants set how much correction that number buys.

use crate::types::AdjustmentModel;

/// Projective coefficient at a keystone slider's ±100 end.
///
/// At `0.5`, a full-strength vertical keystone maps the far edge's `w` to
/// `0.5` and the near edge's to `1.5` — a 2× / 0.67× trapezoid, comfortably
/// past any real architectural correction. Kept below `1.0` deliberately: a
/// single axis at full strength can then never drive `w` to zero anywhere
/// inside the source frame. Two axes at full strength still can, at one
/// corner, which is why [`Homography::project`] reports the singular case
/// instead of dividing.
pub const KEYSTONE_MAX: f32 = 0.5;

/// Horizontal stretch factor at `aspect = +100`; the vertical axis takes its
/// reciprocal, so the transform preserves frame area at every setting.
pub const ASPECT_MAX_RATIO: f32 = 1.5;

/// Frame shift at an offset slider's ±100 end, in half-extents — `1.0` is
/// half the frame width (or height), which is as far as an offset can travel
/// before the frame holds nothing but surround.
pub const OFFSET_MAX: f32 = 1.0;

/// A projective transform in the normalized space described in the module
/// docs, stored row-major.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Homography(pub [f32; 9]);

/// Below this, a projected `w` is treated as the point being on or behind the
/// horizon — outside the image rather than at an enormous coordinate.
const W_EPSILON: f32 = 1.0e-6;

impl Homography {
    pub const IDENTITY: Self = Self([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

    /// Row-major matrix product, `self · rhs`.
    pub fn mul(&self, rhs: &Self) -> Self {
        let a = &self.0;
        let b = &rhs.0;
        let mut out = [0.0f32; 9];
        for row in 0..3 {
            for col in 0..3 {
                out[row * 3 + col] =
                    a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
            }
        }
        Self(out)
    }

    /// Matrix inverse via the adjugate, or `None` when the matrix is
    /// singular. Callers treat `None` as "no transform" rather than
    /// propagating a NaN through a whole frame.
    pub fn inverse(&self) -> Option<Self> {
        let m = &self.0;
        let c00 = m[4] * m[8] - m[5] * m[7];
        let c01 = m[5] * m[6] - m[3] * m[8];
        let c02 = m[3] * m[7] - m[4] * m[6];
        let det = m[0] * c00 + m[1] * c01 + m[2] * c02;
        if !det.is_finite() || det.abs() < f32::EPSILON {
            return None;
        }
        let inv_det = 1.0 / det;
        Some(Self([
            c00 * inv_det,
            (m[2] * m[7] - m[1] * m[8]) * inv_det,
            (m[1] * m[5] - m[2] * m[4]) * inv_det,
            c01 * inv_det,
            (m[0] * m[8] - m[2] * m[6]) * inv_det,
            (m[2] * m[3] - m[0] * m[5]) * inv_det,
            c02 * inv_det,
            (m[1] * m[6] - m[0] * m[7]) * inv_det,
            (m[0] * m[4] - m[1] * m[3]) * inv_det,
        ]))
    }

    /// Project a normalized point, or `None` when it lands on or behind the
    /// projective horizon. A `None` destination pixel reads as outside the
    /// source image, which is the same answer the sampler gives for a point
    /// that projects to a finite coordinate outside the frame.
    #[inline]
    pub fn project(&self, x: f32, y: f32) -> Option<(f32, f32)> {
        let m = &self.0;
        let w = m[6] * x + m[7] * y + m[8];
        if w.abs() < W_EPSILON {
            return None;
        }
        Some((
            (m[0] * x + m[1] * y + m[2]) / w,
            (m[3] * x + m[4] * y + m[5]) / w,
        ))
    }
}

/// The seven manual-geometry sliders, lifted off [`AdjustmentModel`] so the
/// matrix math has one small input to reason about and one small input to
/// test against.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Perspective {
    pub vertical: f32,
    pub horizontal: f32,
    pub rotate: f32,
    pub scale: f32,
    pub aspect: f32,
    pub x: f32,
    pub y: f32,
}

impl Perspective {
    /// Every slider at the value that makes its factor the identity.
    pub const IDENTITY: Self = Self {
        vertical: 0.0,
        horizontal: 0.0,
        rotate: 0.0,
        scale: 100.0,
        aspect: 0.0,
        x: 0.0,
        y: 0.0,
    };

    pub fn from_model(model: &AdjustmentModel) -> Self {
        Self {
            vertical: model.perspective_vertical,
            horizontal: model.perspective_horizontal,
            rotate: model.perspective_rotate,
            scale: model.perspective_scale,
            aspect: model.perspective_aspect,
            x: model.perspective_x,
            y: model.perspective_y,
        }
    }

    /// True iff every slider sits at its default, in which case the stage is
    /// skipped bit-identically. Equality is exact for the same reason
    /// [`crate::types::Crop::is_identity`]'s is: the defaults are concrete
    /// literals that round-trip through XMP without drift.
    pub fn is_identity(&self) -> bool {
        *self == Self::IDENTITY
    }

    /// Source → destination, in normalized space. `aspect_ratio` is the
    /// display-oriented `width / height`, needed only by the rotation factor.
    pub fn matrix(&self, aspect_ratio: f32) -> Homography {
        let m = Matrices::new(self, aspect_ratio);
        m.offset
            .mul(&m.scale)
            .mul(&m.aspect)
            .mul(&m.rotation)
            .mul(&m.keystone)
    }

    /// Destination → source, the direction an inverse-warp sampler needs.
    /// Falls back to the identity on a singular composition, which no
    /// in-range slider combination produces but which a corrupt sidecar
    /// could ask for.
    pub fn inverse_matrix(&self, aspect_ratio: f32) -> Homography {
        self.matrix(aspect_ratio)
            .inverse()
            .unwrap_or(Homography::IDENTITY)
    }
}

/// The five factors, named, so the composition in [`Perspective::matrix`]
/// reads as its own documentation.
struct Matrices {
    keystone: Homography,
    rotation: Homography,
    aspect: Homography,
    scale: Homography,
    offset: Homography,
}

impl Matrices {
    fn new(p: &Perspective, aspect_ratio: f32) -> Self {
        let kh = KEYSTONE_MAX * p.horizontal / 100.0;
        let kv = KEYSTONE_MAX * p.vertical / 100.0;
        let (sin_t, cos_t) = p.rotate.to_radians().sin_cos();
        // Rotation is conjugated by `diag(ar, 1)` so it stays circular on a
        // non-square frame; `ar` is guarded because a zero-height frame would
        // otherwise divide by zero on the way in.
        let ar = if aspect_ratio.is_finite() && aspect_ratio > 0.0 {
            aspect_ratio
        } else {
            1.0
        };
        let stretch = ASPECT_MAX_RATIO.powf(p.aspect / 100.0);
        let scale = p.scale / 100.0;
        Self {
            keystone: Homography([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, kh, kv, 1.0]),
            rotation: Homography([
                cos_t,
                -sin_t / ar,
                0.0,
                sin_t * ar,
                cos_t,
                0.0,
                0.0,
                0.0,
                1.0,
            ]),
            aspect: Homography([stretch, 0.0, 0.0, 0.0, 1.0 / stretch, 0.0, 0.0, 0.0, 1.0]),
            scale: Homography([scale, 0.0, 0.0, 0.0, scale, 0.0, 0.0, 0.0, 1.0]),
            offset: Homography([
                1.0,
                0.0,
                OFFSET_MAX * p.x / 100.0,
                0.0,
                1.0,
                OFFSET_MAX * p.y / 100.0,
                0.0,
                0.0,
                1.0,
            ]),
        }
    }
}

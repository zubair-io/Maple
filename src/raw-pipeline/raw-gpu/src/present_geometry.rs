//! Numeric display-tail carrier. Transform math and crop rounding live in raw-core.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct QuantizedDisplayTail {
    pub orientation_rows: [[f32; 4]; 2],
    pub crop_rows: [[f32; 4]; 2],
    /// Rect origin, cos(-angle), sin(-angle).
    pub crop_rotation: [f32; 4],
    /// Oriented width, oriented height, enabled, bilinear crop.
    pub dimensions: [u32; 4],
    pub output_size: [u32; 2],
}

impl QuantizedDisplayTail {
    pub const DISABLED: Self = Self {
        orientation_rows: [[0.; 4]; 2],
        crop_rows: [[0.; 4]; 2],
        crop_rotation: [0.; 4],
        dimensions: [0; 4],
        output_size: [0; 2],
    };
}

/// The manual-geometry homography the present shader warps by (#3410).
///
/// Three `vec4` rows of the DESTINATION → SOURCE matrix in the centred,
/// half-extent-normalized `[-1, 1]` space `raw-core`'s
/// `stages::perspective::matrix` defines; `rows[0][3]` is the active flag.
/// `raw-gpu` does not depend on `raw-core` (the dependency runs the other way,
/// through raw-core's optional `gpu` feature), so the matrix is *built* by the
/// core and *carried* here as plain numbers — one implementation of the math,
/// no second copy to keep in step.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PresentGeometry {
    pub(crate) rows: [[f32; 4]; 3],
    pub(crate) tail: QuantizedDisplayTail,
}

impl PresentGeometry {
    /// No manual geometry: the present takes its untouched pre-#3410 load
    /// paths, byte for byte.
    pub const IDENTITY: Self = Self {
        rows: [[0.0; 4]; 3],
        tail: QuantizedDisplayTail::DISABLED,
    };

    /// Wrap a row-major destination → source homography. Callers pass
    /// `raw_core::stages::perspective::Perspective::inverse_matrix`'s output.
    pub fn from_inverse(m: [f32; 9]) -> Self {
        Self {
            rows: [
                [m[0], m[1], m[2], 1.0],
                [m[3], m[4], m[5], 0.0],
                [m[6], m[7], m[8], 0.0],
            ],
            tail: QuantizedDisplayTail::DISABLED,
        }
    }

    /// Complete quantized display tail, authored by the shared core (#3982).
    pub fn with_quantized_tail(mut self, tail: QuantizedDisplayTail) -> Self {
        self.tail = tail;
        self
    }

    pub fn surface_dimensions(&self, source: (u32, u32)) -> (u32, u32) {
        if self.tail.dimensions[2] == 0 {
            source
        } else {
            (self.tail.output_size[0], self.tail.output_size[1])
        }
    }

    /// True when this actually warps — i.e. the shader will take the resample
    /// arm rather than the direct load.
    pub fn is_active(&self) -> bool {
        self.rows[0][3] != 0.0
    }
}

impl Default for PresentGeometry {
    fn default() -> Self {
        Self::IDENTITY
    }
}

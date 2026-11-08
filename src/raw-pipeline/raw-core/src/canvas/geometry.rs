//! Plain 2-D values for canvas math. `Size` doubles as a pan offset or a
//! drag translation (positive = right/down), matching the platform gesture
//! conventions it is ported from.

/// A 2-D extent or offset; units are the caller's (points or pixels).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

impl Size {
    pub const ZERO: Size = Size {
        width: 0.0,
        height: 0.0,
    };

    #[must_use]
    pub const fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }

    /// Both components exactly zero — the "not known yet" sentinel for a
    /// viewport or an image extent.
    #[must_use]
    pub fn is_zero(self) -> bool {
        self.width == 0.0 && self.height == 0.0
    }

    #[must_use]
    pub fn is_finite(self) -> bool {
        self.width.is_finite() && self.height.is_finite()
    }

    /// An extent with a non-finite or negative component becomes `ZERO`, so
    /// downstream math treats it as unknown instead of propagating NaN.
    #[must_use]
    pub fn sanitized_extent(self) -> Self {
        let valid = self.is_finite() && self.width >= 0.0 && self.height >= 0.0;
        if valid {
            self
        } else {
            Self::ZERO
        }
    }

    /// An offset with each non-finite component replaced by zero.
    #[must_use]
    pub fn sanitized_offset(self) -> Self {
        Self {
            width: finite_or_zero(self.width),
            height: finite_or_zero(self.height),
        }
    }
}

/// A position, typically in viewport points from the top-left corner.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const ZERO: Point = Point { x: 0.0, y: 0.0 };

    #[must_use]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    #[must_use]
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

/// An axis-aligned rectangle: origin at the top-left, then extent.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const ZERO: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };
}

fn finite_or_zero(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

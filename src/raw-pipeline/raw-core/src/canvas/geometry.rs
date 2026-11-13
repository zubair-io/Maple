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

    #[must_use]
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// The rect anchored at the origin with `size` as its extent.
    #[must_use]
    pub const fn from_size(size: Size) -> Self {
        Self::new(0.0, 0.0, size.width, size.height)
    }

    #[must_use]
    pub fn max_x(self) -> f64 {
        self.x + self.width
    }

    #[must_use]
    pub fn max_y(self) -> f64 {
        self.y + self.height
    }

    #[must_use]
    pub fn is_finite(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
    }

    /// The same region with a non-negative extent (a negative width moves
    /// the origin to the other edge), as `CGRect.standardized` does.
    #[must_use]
    pub fn standardized(self) -> Self {
        let (x, width) = if self.width < 0.0 {
            (self.x + self.width, -self.width)
        } else {
            (self.x, self.width)
        };
        let (y, height) = if self.height < 0.0 {
            (self.y + self.height, -self.height)
        } else {
            (self.y, self.height)
        };
        Self::new(x, y, width, height)
    }

    /// No area: an axis of zero length, or any non-finite component. A
    /// negative extent is not empty; standardize it first.
    #[must_use]
    pub fn is_empty(self) -> bool {
        !self.is_finite() || self.width == 0.0 || self.height == 0.0
    }

    /// The smallest integer-aligned rect containing this one (origin rounded
    /// down, far edges rounded up), as `CGRect.integral` does.
    #[must_use]
    pub fn integral(self) -> Self {
        let rect = self.standardized();
        let x = rect.x.floor();
        let y = rect.y.floor();
        Self::new(x, y, rect.max_x().ceil() - x, rect.max_y().ceil() - y)
    }

    /// Grow (negative `dx`/`dy`) or shrink each edge by the given amount.
    #[must_use]
    pub fn inset(self, dx: f64, dy: f64) -> Self {
        Self::new(
            self.x + dx,
            self.y + dy,
            self.width - 2.0 * dx,
            self.height - 2.0 * dy,
        )
    }

    /// The overlap of two standardized rects; `None` when they are disjoint
    /// or either is non-finite. Rects that only touch share a zero-length
    /// edge, which `is_empty` reports.
    #[must_use]
    pub fn intersection(self, other: Rect) -> Option<Rect> {
        let a = self.standardized();
        let b = other.standardized();
        if !a.is_finite() || !b.is_finite() {
            return None;
        }
        let x = a.x.max(b.x);
        let y = a.y.max(b.y);
        let max_x = a.max_x().min(b.max_x());
        let max_y = a.max_y().min(b.max_y());
        (max_x >= x && max_y >= y).then(|| Rect::new(x, y, max_x - x, max_y - y))
    }

    /// Whether `other` lies inside this rect, edges inclusive. False when
    /// either rect is non-finite.
    #[must_use]
    pub fn contains_rect(self, other: Rect) -> bool {
        let a = self.standardized();
        let b = other.standardized();
        a.is_finite()
            && b.is_finite()
            && b.x >= a.x
            && b.y >= a.y
            && b.max_x() <= a.max_x()
            && b.max_y() <= a.max_y()
    }
}

/// How far the host's chrome (toolbars, inspector, filmstrip, safe-area
/// insets) covers the viewport from each edge, in points.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Insets {
    pub top: f64,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
}

impl Insets {
    pub const ZERO: Insets = Insets {
        top: 0.0,
        left: 0.0,
        bottom: 0.0,
        right: 0.0,
    };

    #[must_use]
    pub const fn new(top: f64, left: f64, bottom: f64, right: f64) -> Self {
        Self {
            top,
            left,
            bottom,
            right,
        }
    }

    /// Non-finite or negative edges become zero, and an axis whose two
    /// insets leave no room inside `extent` drops to zero, so the visible
    /// area is never empty while the viewport is not.
    #[must_use]
    pub fn sanitized_within(self, extent: Size) -> Self {
        let edge = |value: f64| {
            if value.is_finite() {
                value.max(0.0)
            } else {
                0.0
            }
        };
        let (top, bottom) = (edge(self.top), edge(self.bottom));
        let (left, right) = (edge(self.left), edge(self.right));
        let (top, bottom) = if top + bottom < extent.height {
            (top, bottom)
        } else {
            (0.0, 0.0)
        };
        let (left, right) = if left + right < extent.width {
            (left, right)
        } else {
            (0.0, 0.0)
        };
        Self::new(top, left, bottom, right)
    }
}

fn finite_or_zero(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

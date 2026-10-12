//! User seam constraints (#4520): a photographer's intent the content-aware
//! cut cannot infer — keep this instance of a moving subject
//! ([`SeamConstraint::ForceInclude`]), or make sure that passer-by never
//! shows ([`SeamConstraint::ForceExclude`]).
//!
//! Constraints are full-canvas rectangles. [`rasterize`] maps each onto the
//! seam canvas as every seam pixel whose footprint touches the rectangle,
//! then grows it by a [`HALO_PX`] halo so the feathered, bilinearly
//! upsampled weights stay exactly 1 (include) or 0 (exclude) across the
//! whole full-resolution rectangle. The core is authoritative and every
//! contradiction in it is a [`SeamConstraintError`]; the halo is
//! best-effort and simply yields wherever it would contradict a core pin,
//! another halo, or a frame's footprint.
//!
//! The resulting [`SeamPins`] drive the label solve: a pinned pixel starts
//! on its forced frame, and every pairwise expansion move wires pinned
//! pixels to their terminal with infinite capacity, so the cut can only
//! route around them.

use crate::canvas::CanvasSpec;
use crate::ingest::PlanarImage;

use super::labels::UNLABELLED;
use super::masks::FEATHER_RADIUS_PX;

/// Feather radius plus the one-pixel reach of the bilinear upsample.
pub const HALO_PX: u32 = FEATHER_RADIUS_PX + 1;

const CONTESTED: i32 = -2;

/// An axis-aligned rectangle in full-canvas pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanvasRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// A user seam constraint; the `usize` is the frame index in composite order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeamConstraint {
    /// Every pixel of the rectangle shows this frame.
    ForceInclude(usize, CanvasRect),
    /// No pixel of the rectangle shows this frame.
    ForceExclude(usize, CanvasRect),
}

impl SeamConstraint {
    pub fn frame(&self) -> usize {
        match *self {
            Self::ForceInclude(f, _) | Self::ForceExclude(f, _) => f,
        }
    }

    pub fn rect(&self) -> CanvasRect {
        match *self {
            Self::ForceInclude(_, r) | Self::ForceExclude(_, r) => r,
        }
    }

    pub fn with_frame(self, frame: usize) -> Self {
        match self {
            Self::ForceInclude(_, r) => Self::ForceInclude(frame, r),
            Self::ForceExclude(_, r) => Self::ForceExclude(frame, r),
        }
    }
}

/// Constraints that cannot all hold. Pixel positions are full-canvas
/// coordinates (the centre of the seam-canvas pixel where the conflict was
/// found).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SeamConstraintError {
    #[error("seam constraints need the graph-cut seam strategy on the rotation path")]
    RequiresGraphCut,
    #[error("seam constraint names frame {frame}, but there are only {frames} frame(s)")]
    UnknownFrame { frame: usize, frames: usize },
    #[error("ForceInclude names frame {frame}, which was dropped before compositing")]
    IncludeDroppedFrame { frame: usize },
    #[error(
        "seam constraint region for frame {frame} is empty or outside the \
         {canvas_width}x{canvas_height} canvas"
    )]
    EmptyRegion {
        frame: usize,
        canvas_width: u32,
        canvas_height: u32,
    },
    #[error(
        "ForceInclude regions for frames {first} and {second} overlap near canvas pixel ({x}, {y})"
    )]
    OverlappingIncludes {
        first: usize,
        second: usize,
        x: u32,
        y: u32,
    },
    #[error(
        "ForceInclude region for frame {frame} leaves that frame's footprint near canvas pixel \
         ({x}, {y})"
    )]
    IncludeOutsideFrame { frame: usize, x: u32, y: u32 },
    #[error(
        "frame {frame} is both force-included and force-excluded near canvas pixel ({x}, {y})"
    )]
    IncludeExcluded { frame: usize, x: u32, y: u32 },
    #[error("ForceExclude regions leave no frame to show near canvas pixel ({x}, {y})")]
    NoCandidate { x: u32, y: u32 },
}

/// Per-seam-pixel pins. Empty planes mean "unconstrained", so the
/// no-constraint solve allocates nothing.
#[derive(Debug, Default)]
pub struct SeamPins {
    forced: Vec<i32>,
    excluded: Vec<Vec<bool>>,
}

impl SeamPins {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn forced(&self, px: usize) -> Option<usize> {
        self.forced
            .get(px)
            .filter(|&&f| f >= 0)
            .map(|&f| f as usize)
    }

    pub fn allows(&self, frame: usize, px: usize) -> bool {
        let forced_ok = self.forced(px).is_none_or(|f| f == frame);
        let excluded = self
            .excluded
            .get(frame)
            .and_then(|plane| plane.get(px))
            .copied()
            .unwrap_or(false);
        forced_ok && !excluded
    }
}

/// Reject constraints that are wrong before any pixel is looked at.
pub fn validate(
    constraints: &[SeamConstraint],
    n_frames: usize,
    full_canvas: &CanvasSpec,
) -> Result<(), SeamConstraintError> {
    constraints.iter().try_for_each(|c| {
        let r = c.rect();
        if c.frame() >= n_frames {
            return Err(SeamConstraintError::UnknownFrame {
                frame: c.frame(),
                frames: n_frames,
            });
        }
        let empty =
            r.width == 0 || r.height == 0 || r.x >= full_canvas.width || r.y >= full_canvas.height;
        if empty {
            return Err(SeamConstraintError::EmptyRegion {
                frame: c.frame(),
                canvas_width: full_canvas.width,
                canvas_height: full_canvas.height,
            });
        }
        Ok(())
    })
}

/// Half-open seam-pixel bounds `[x0, x1) × [y0, y1)`.
#[derive(Clone, Copy)]
struct SeamBox {
    x0: u32,
    x1: u32,
    y0: u32,
    y1: u32,
}

impl SeamBox {
    fn grown(self, by: u32, w: u32, h: u32) -> Self {
        Self {
            x0: self.x0.saturating_sub(by),
            x1: (self.x1 + by).min(w),
            y0: self.y0.saturating_sub(by),
            y1: (self.y1 + by).min(h),
        }
    }

    fn contains(&self, x: u32, y: u32) -> bool {
        (self.x0..self.x1).contains(&x) && (self.y0..self.y1).contains(&y)
    }

    fn pixels(self) -> impl Iterator<Item = (u32, u32)> {
        (self.y0..self.y1).flat_map(move |y| (self.x0..self.x1).map(move |x| (x, y)))
    }
}

struct Geometry<'a> {
    layers: &'a [PlanarImage],
    width: u32,
    height: u32,
    scale_x: f64,
    scale_y: f64,
}

impl Geometry<'_> {
    fn idx(&self, x: u32, y: u32) -> usize {
        (y as usize) * (self.width as usize) + x as usize
    }

    fn valid(&self, frame: usize, x: u32, y: u32) -> bool {
        self.layers[frame].validity.get(x, y)
    }

    fn covered(&self, x: u32, y: u32) -> bool {
        self.layers.iter().any(|l| l.validity.get(x, y))
    }

    fn core(&self, r: CanvasRect) -> SeamBox {
        let span = |lo: u32, len: u32, scale: f64, cap: u32| {
            let a = ((lo as f64 * scale).floor() as u32).min(cap);
            let b = (((lo as f64 + len as f64) * scale).ceil() as u32).clamp(a, cap);
            (a, b)
        };
        let (x0, x1) = span(r.x, r.width, self.scale_x, self.width);
        let (y0, y1) = span(r.y, r.height, self.scale_y, self.height);
        SeamBox { x0, x1, y0, y1 }
    }

    fn canvas_xy(&self, x: u32, y: u32) -> (u32, u32) {
        (
            ((x as f64 + 0.5) / self.scale_x) as u32,
            ((y as f64 + 0.5) / self.scale_y) as u32,
        )
    }
}

/// Rasterize validated constraints onto the seam canvas the `layers` were
/// warped to. `scale_*` is seam pixels per full-canvas pixel.
pub fn rasterize(
    constraints: &[SeamConstraint],
    layers: &[PlanarImage],
    scale_x: f64,
    scale_y: f64,
) -> Result<SeamPins, SeamConstraintError> {
    if constraints.is_empty() || layers.is_empty() {
        return Ok(SeamPins::none());
    }
    let geo = Geometry {
        layers,
        width: layers[0].width(),
        height: layers[0].height(),
        scale_x,
        scale_y,
    };
    let n_px = (geo.width as usize) * (geo.height as usize);
    let mut forced = vec![UNLABELLED; n_px];
    let mut excluded: Vec<Vec<bool>> = vec![Vec::new(); layers.len()];

    for c in constraints {
        let core = geo.core(c.rect());
        match *c {
            SeamConstraint::ForceInclude(f, _) => {
                for (x, y) in core.pixels() {
                    let (cx, cy) = geo.canvas_xy(x, y);
                    if !geo.valid(f, x, y) {
                        return Err(SeamConstraintError::IncludeOutsideFrame {
                            frame: f,
                            x: cx,
                            y: cy,
                        });
                    }
                    let slot = &mut forced[geo.idx(x, y)];
                    if *slot != UNLABELLED && *slot != f as i32 {
                        return Err(SeamConstraintError::OverlappingIncludes {
                            first: *slot as usize,
                            second: f,
                            x: cx,
                            y: cy,
                        });
                    }
                    *slot = f as i32;
                }
            }
            SeamConstraint::ForceExclude(f, _) => {
                let plane = &mut excluded[f];
                if plane.is_empty() {
                    plane.resize(n_px, false);
                }
                core.pixels().for_each(|(x, y)| plane[geo.idx(x, y)] = true);
            }
        }
    }

    let mut pins = SeamPins { forced, excluded };
    for c in constraints {
        for (x, y) in geo.core(c.rect()).pixels() {
            let px = geo.idx(x, y);
            let (cx, cy) = geo.canvas_xy(x, y);
            if let Some(f) = pins.forced(px).filter(|&f| !pins.allows(f, px)) {
                return Err(SeamConstraintError::IncludeExcluded {
                    frame: f,
                    x: cx,
                    y: cy,
                });
            }
            if geo.covered(x, y) && !has_candidate(&geo, &pins, x, y) {
                return Err(SeamConstraintError::NoCandidate { x: cx, y: cy });
            }
        }
    }

    grow_halos(constraints, &geo, &mut pins);
    Ok(pins)
}

fn has_candidate(geo: &Geometry, pins: &SeamPins, x: u32, y: u32) -> bool {
    let px = geo.idx(x, y);
    (0..geo.layers.len()).any(|f| geo.valid(f, x, y) && pins.allows(f, px))
}

fn grow_halos(constraints: &[SeamConstraint], geo: &Geometry, pins: &mut SeamPins) {
    let mut claims = vec![UNLABELLED; pins.forced.len()];
    for c in constraints {
        let SeamConstraint::ForceInclude(f, r) = *c else {
            continue;
        };
        for (x, y) in geo.core(r).grown(HALO_PX, geo.width, geo.height).pixels() {
            let px = geo.idx(x, y);
            if pins.forced(px).is_some() || !geo.valid(f, x, y) || !pins.allows(f, px) {
                continue;
            }
            claims[px] = match claims[px] {
                UNLABELLED => f as i32,
                prior if prior == f as i32 => prior,
                _ => CONTESTED,
            };
        }
    }
    for (slot, &claim) in pins.forced.iter_mut().zip(&claims) {
        if claim >= 0 {
            *slot = claim;
        }
    }

    for c in constraints {
        let SeamConstraint::ForceExclude(f, r) = *c else {
            continue;
        };
        let core = geo.core(r);
        for (x, y) in core.grown(HALO_PX, geo.width, geo.height).pixels() {
            let px = geo.idx(x, y);
            if core.contains(x, y) || pins.excluded[f][px] || pins.forced(px) == Some(f) {
                continue;
            }
            pins.excluded[f][px] = true;
            if geo.covered(x, y) && !has_candidate(geo, pins, x, y) {
                pins.excluded[f][px] = false;
            }
        }
    }
}

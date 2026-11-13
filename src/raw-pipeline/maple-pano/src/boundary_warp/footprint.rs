//! The panorama's footprint and the shape of its outer edge.
//!
//! [`Footprint`] is a coverage mask over a downscaled copy of the output
//! canvas. [`outer_edge`] turns it into the closed curve the rest mesh is
//! pinned to: inset two cells (so the curve lies strictly inside coverage),
//! reduced to its largest 4-connected region with holes filled, traced along
//! pixel edges, split into four arcs at its extreme points along the two
//! diagonals, and smoothed along each arc. Tracing one closed curve gives the four
//! arcs shared corners by construction.

use std::collections::{HashMap, VecDeque};

use rayon::prelude::*;

use super::BoundaryWarpStatus;

type Segment = ((f64, f64), (f64, f64));

/// Coverage on a `width × height` grid laid over the output canvas, row-major.
/// `full_wrap` marks a canvas whose periodic axis spans 360°.
#[derive(Debug, Clone, PartialEq)]
pub struct Footprint {
    width: u32,
    height: u32,
    covered: Vec<bool>,
    full_wrap: bool,
}

/// A coverage mask whose length is not `width × height`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("footprint mask has {actual} cells, expected {width} x {height}")]
pub struct FootprintError {
    pub width: u32,
    pub height: u32,
    pub actual: usize,
}

impl Footprint {
    pub fn new(
        width: u32,
        height: u32,
        covered: Vec<bool>,
        full_wrap: bool,
    ) -> Result<Self, FootprintError> {
        if (width as usize).checked_mul(height as usize) != Some(covered.len()) {
            return Err(FootprintError {
                width,
                height,
                actual: covered.len(),
            });
        }
        Ok(Self {
            width,
            height,
            covered,
            full_wrap,
        })
    }

    /// Evaluates `covered(x, y)` at every grid cell, rows in parallel.
    pub fn from_fn(
        width: u32,
        height: u32,
        full_wrap: bool,
        covered: impl Fn(u32, u32) -> bool + Sync,
    ) -> Self {
        let mask = (0..height)
            .into_par_iter()
            .flat_map_iter(|y| (0..width).map(move |x| (x, y)))
            .map(|(x, y)| covered(x, y))
            .collect();
        Self {
            width,
            height,
            covered: mask,
            full_wrap,
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn is_full_wrap(&self) -> bool {
        self.full_wrap
    }

    /// This footprint on a grid at most `long_edge` cells on its long side,
    /// spanning the same rectangle. A coarse cell is covered only when every
    /// fine cell it overlaps is, so coarse coverage never claims more.
    pub(super) fn coarsened(&self, long_edge: u32) -> Footprint {
        let long = self.width.max(self.height);
        if long <= long_edge {
            return self.clone();
        }
        let scale = long_edge as f64 / long as f64;
        let (cw, ch) = (
            ((self.width as f64 * scale).round() as u32).max(1),
            ((self.height as f64 * scale).round() as u32).max(1),
        );
        let span = |c: u32, coarse: u32, fine: u32| {
            let (lo, hi) = (
                c as f64 * fine as f64 / coarse as f64,
                (c + 1) as f64 * fine as f64 / coarse as f64,
            );
            (lo.floor() as i64)..(hi.ceil() as i64).min(fine as i64)
        };
        Footprint::from_fn(cw, ch, self.full_wrap, |x, y| {
            span(y, ch, self.height).all(|fy| span(x, cw, self.width).all(|fx| self.at(fx, fy)))
        })
    }

    /// Whether the cell containing grid position `(x, y)` is covered; `false`
    /// off the grid.
    pub fn covers(&self, x: f64, y: f64) -> bool {
        if !(x >= 0.0 && y >= 0.0 && x < self.width as f64 && y < self.height as f64) {
            return false;
        }
        self.at(x as i64, y as i64)
    }

    fn at(&self, x: i64, y: i64) -> bool {
        (0..self.width as i64).contains(&x)
            && (0..self.height as i64).contains(&y)
            && self.covered[y as usize * self.width as usize + x as usize]
    }
}

/// The traced outer edge: a closed curve in grid units, clockwise on screen
/// (east along the top), the indices of its top-left, top-right,
/// bottom-right and bottom-left corners in that order.
pub(super) struct OuterEdge {
    pub(super) curve: Vec<(f64, f64)>,
    pub(super) corners: [usize; 4],
}

/// Cells (in the L1 sense) the traced edge keeps from uncovered cells. A cell
/// counts as covered when its centre is, so its far side can be half a cell
/// past true coverage; mesh edges cutting across a notch corner take up
/// about another half.
const INSET: i64 = 2;
/// A region smaller than this many cells is too small to hold a mesh.
const MIN_REGION_CELLS: usize = 64;
/// A second region at least this fraction of the largest makes the footprint
/// disconnected; smaller specks are ignored.
const SECOND_REGION_FRACTION: f64 = 0.01;
/// Passes of the held-inside moving average. Each pass widens the ramp a
/// step or notch becomes, so the rest mesh's harmonic interior can follow it
/// with fewer folds.
const SMOOTHING_PASSES: usize = 12;
/// `smoothing` is the moving average's half-width in grid cells, about one
/// mesh cell.
pub(super) fn outer_edge(
    footprint: &Footprint,
    smoothing: usize,
) -> Result<OuterEdge, BoundaryWarpStatus> {
    let (w, h) = (footprint.width as i64, footprint.height as i64);
    let eroded: Vec<bool> = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| {
            (-INSET..=INSET)
                .flat_map(|dy| (-INSET..=INSET).map(move |dx| (dx, dy)))
                .filter(|&(dx, dy)| dx.abs() + dy.abs() <= INSET)
                .all(|(dx, dy)| footprint.at(x + dx, y + dy))
        })
        .collect();
    let region = largest_region(&eroded, w, h)?;
    let filled = fill_holes(&region, w, h);
    let lattice = trace(&filled, w, h);
    let raw = resample_closed(&lattice, 1.0);
    let corners = split_corners(&raw).ok_or(BoundaryWarpStatus::RefusedShape)?;
    let inside = |(x, y): (f64, f64)| {
        let (cx, cy) = (x.floor() as i64, y.floor() as i64);
        (0..w).contains(&cx) && (0..h).contains(&cy) && filled[(cy * w + cx) as usize]
    };
    let curve = (0..SMOOTHING_PASSES).fold(raw, |curve, _| {
        smooth_arcs(&curve, corners, smoothing, &inside)
    });
    Ok(OuterEdge { curve, corners })
}

fn largest_region(mask: &[bool], w: i64, h: i64) -> Result<Vec<bool>, BoundaryWarpStatus> {
    let mut label = vec![usize::MAX; mask.len()];
    let mut sizes: Vec<usize> = Vec::new();
    for start in 0..mask.len() {
        if !mask[start] || label[start] != usize::MAX {
            continue;
        }
        let id = sizes.len();
        let mut size = 0;
        let mut queue = VecDeque::from([start]);
        label[start] = id;
        while let Some(i) = queue.pop_front() {
            size += 1;
            let (x, y) = ((i as i64) % w, (i as i64) / w);
            for (nx, ny) in [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)] {
                if !(0..w).contains(&nx) || !(0..h).contains(&ny) {
                    continue;
                }
                let n = (ny * w + nx) as usize;
                if mask[n] && label[n] == usize::MAX {
                    label[n] = id;
                    queue.push_back(n);
                }
            }
        }
        sizes.push(size);
    }
    let Some((largest, &largest_size)) = sizes
        .iter()
        .enumerate()
        .max_by_key(|&(i, &s)| (s, usize::MAX - i))
    else {
        return Err(BoundaryWarpStatus::RefusedEmpty);
    };
    if largest_size < MIN_REGION_CELLS {
        return Err(BoundaryWarpStatus::RefusedEmpty);
    }
    let floor = (largest_size as f64 * SECOND_REGION_FRACTION).max(MIN_REGION_CELLS as f64);
    if sizes
        .iter()
        .enumerate()
        .any(|(i, &s)| i != largest && s as f64 >= floor)
    {
        return Err(BoundaryWarpStatus::RefusedDisconnected);
    }
    Ok(label.iter().map(|&l| l == largest).collect())
}

/// The region plus every cell not reachable from the grid border through
/// 8-connected non-region cells (the complement connectivity of a
/// 4-connected region).
fn fill_holes(region: &[bool], w: i64, h: i64) -> Vec<bool> {
    let mut outside = vec![false; region.len()];
    let mut queue: VecDeque<usize> = (0..region.len())
        .filter(|&i| {
            let (x, y) = ((i as i64) % w, (i as i64) / w);
            !region[i] && (x == 0 || y == 0 || x == w - 1 || y == h - 1)
        })
        .collect();
    queue.iter().for_each(|&i| outside[i] = true);
    while let Some(i) = queue.pop_front() {
        let (x, y) = ((i as i64) % w, (i as i64) / w);
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (nx, ny) = (x + dx, y + dy);
                if !(0..w).contains(&nx) || !(0..h).contains(&ny) {
                    continue;
                }
                let n = (ny * w + nx) as usize;
                if !region[n] && !outside[n] {
                    outside[n] = true;
                    queue.push_back(n);
                }
            }
        }
    }
    outside.iter().map(|&o| !o).collect()
}

/// Lattice points of the region's outer boundary, walking cell edges with
/// the region on the right. Where two cells touch only at a corner the walk
/// turns right, staying on the cell it is following.
fn trace(region: &[bool], w: i64, h: i64) -> Vec<(i64, i64)> {
    let inside =
        |x: i64, y: i64| (0..w).contains(&x) && (0..h).contains(&y) && region[(y * w + x) as usize];
    let mut out: HashMap<(i64, i64), Vec<(i64, i64)>> = HashMap::new();
    for y in 0..h {
        for x in (0..w).filter(|&x| inside(x, y)) {
            let sides = [
                (!inside(x, y - 1), (x, y), (1, 0)),
                (!inside(x + 1, y), (x + 1, y), (0, 1)),
                (!inside(x, y + 1), (x + 1, y + 1), (-1, 0)),
                (!inside(x - 1, y), (x, y + 1), (0, -1)),
            ];
            for (open, from, dir) in sides {
                if open {
                    out.entry(from).or_default().push(dir);
                }
            }
        }
    }
    let start = (0..region.len())
        .find(|&i| region[i])
        .map(|i| ((i as i64) % w, (i as i64) / w))
        .expect("region is non-empty");
    let mut points = vec![start];
    let (mut at, mut dir) = ((start.0 + 1, start.1), (1, 0));
    while at != start {
        points.push(at);
        let turns = [(-dir.1, dir.0), dir, (dir.1, -dir.0)];
        dir = *turns
            .iter()
            .find(|t| out.get(&at).is_some_and(|d| d.contains(t)))
            .expect("a closed boundary always continues");
        at = (at.0 + dir.0, at.1 + dir.1);
    }
    points
}

/// Points spaced `step` apart along the closed polyline.
fn resample_closed(points: &[(i64, i64)], step: f64) -> Vec<(f64, f64)> {
    let pts: Vec<(f64, f64)> = points.iter().map(|&(x, y)| (x as f64, y as f64)).collect();
    let segments: Vec<Segment> = pts
        .iter()
        .zip(pts.iter().cycle().skip(1))
        .map(|(&a, &b)| (a, b))
        .collect();
    let total: f64 = segments.iter().map(|&(a, b)| dist(a, b)).sum();
    let count = (total / step).round().max(4.0) as usize;
    sample_polyline(&segments, total, count, false)
}

/// `count` points evenly spaced in arc length along `segments`, the last at
/// the end when `include_end` (for an open arc) or one step short (closed).
fn sample_polyline(
    segments: &[Segment],
    total: f64,
    count: usize,
    include_end: bool,
) -> Vec<(f64, f64)> {
    let spacing = total / (if include_end { count - 1 } else { count }) as f64;
    let mut out = Vec::with_capacity(count);
    let mut seg = 0;
    let mut seg_start = 0.0;
    for i in 0..count {
        let s = (i as f64 * spacing).min(total);
        while seg + 1 < segments.len() && seg_start + dist(segments[seg].0, segments[seg].1) < s {
            seg_start += dist(segments[seg].0, segments[seg].1);
            seg += 1;
        }
        let (a, b) = segments[seg];
        let len = dist(a, b);
        let f = if len > 0.0 {
            ((s - seg_start) / len).clamp(0.0, 1.0)
        } else {
            0.0
        };
        out.push((a.0 + f * (b.0 - a.0), a.1 + f * (b.1 - a.1)));
    }
    out
}

/// A centred moving average along each arc that never reaches past the
/// arc's ends, so the four corners stay where they are and stay sharp.
/// Averaging pulls the curve out across an inward notch, so each smoothed
/// point is drawn back toward its previous position until `inside` holds.
fn smooth_arcs(
    curve: &[(f64, f64)],
    corners: [usize; 4],
    half: usize,
    inside: &impl Fn((f64, f64)) -> bool,
) -> Vec<(f64, f64)> {
    let n = curve.len();
    let mut out = curve.to_vec();
    for k in 0..4 {
        let (from, to) = (corners[k], corners[(k + 1) % 4]);
        let len = (to + n - from) % n;
        for offset in 1..len {
            let reach = half.min(offset).min(len - offset);
            let span = (2 * reach + 1) as f64;
            let (sx, sy) = (offset - reach..=offset + reach)
                .map(|o| curve[(from + o) % n])
                .fold((0.0, 0.0), |(sx, sy), (x, y)| (sx + x, sy + y));
            let previous = curve[(from + offset) % n];
            out[(from + offset) % n] = held_inside(previous, (sx / span, sy / span), inside);
        }
    }
    out
}

/// The point furthest along `from → smoothed` that `inside` accepts, found
/// by bisection; `from` (the previous pass's point) when none is.
fn held_inside(
    from: (f64, f64),
    smoothed: (f64, f64),
    inside: &impl Fn((f64, f64)) -> bool,
) -> (f64, f64) {
    let at = |f: f64| {
        (
            from.0 + f * (smoothed.0 - from.0),
            from.1 + f * (smoothed.1 - from.1),
        )
    };
    if inside(smoothed) {
        return smoothed;
    }
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..24 {
        let mid = 0.5 * (lo + hi);
        if inside(at(mid)) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    at(lo)
}

/// The curve's extreme points along the two diagonals, as the top-left
/// (least `x + y`), top-right (most `x − y`), bottom-right (most `x + y`)
/// and bottom-left (least `x − y`) corners, if they run in that order
/// around the curve. Diagonal extremes find a corner where a sloped edge
/// meets a side; the point nearest the bounding-box corner can slide along
/// the slope instead.
fn split_corners(curve: &[(f64, f64)]) -> Option<[usize; 4]> {
    let first_least = |key: &dyn Fn((f64, f64)) -> f64| {
        (0..curve.len())
            .min_by(|&a, &b| key(curve[a]).total_cmp(&key(curve[b])))
            .expect("curve is non-empty")
    };
    let corners = [
        first_least(&|(x, y)| x + y),
        first_least(&|(x, y)| y - x),
        first_least(&|(x, y)| -x - y),
        first_least(&|(x, y)| x - y),
    ];
    let n = curve.len();
    let offsets: Vec<usize> = corners.iter().map(|&c| (c + n - corners[0]) % n).collect();
    offsets.windows(2).all(|p| p[0] < p[1]).then_some(corners)
}

/// `count` points evenly spaced in arc length along the edge from index
/// `from` forward to index `to`, both included.
pub(super) fn sample_arc(
    edge: &OuterEdge,
    from: usize,
    to: usize,
    count: usize,
) -> Vec<(f64, f64)> {
    let curve = &edge.curve;
    let n = curve.len();
    let len = (to + n - from) % n;
    let segments: Vec<Segment> = (0..len)
        .map(|k| (curve[(from + k) % n], curve[(from + k + 1) % n]))
        .collect();
    let total: f64 = segments.iter().map(|&(a, b)| dist(a, b)).sum();
    sample_polyline(&segments, total, count, true)
}

pub(super) fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

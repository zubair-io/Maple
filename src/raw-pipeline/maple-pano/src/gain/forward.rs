//! Forward points pruned while a frame is swept (#5566).
//!
//! [`thin_points`] keeps a point only when both its grid indices are
//! multiples of the lattice its list's final length implies, so only
//! points whose index gcd reaches that lattice can survive. The lattice
//! never shrinks as points arrive, so a point whose gcd is below the
//! lattice the count so far implies can be dropped at once, and
//! [`ForwardPoints::finish`] equals [`thin_points`] of the whole list. The
//! kept set grows with about the square root of the count instead of the
//! count itself.

#[cfg(doc)]
use super::overlap::thin_points;
use super::overlap::{grid_index, on_lattice, thinning_lattice, PendingPoint};

pub(crate) struct ForwardPoints {
    stride: u32,
    seen: usize,
    floor: u32,
    kept: Vec<PendingPoint>,
}

impl ForwardPoints {
    pub(crate) fn new(stride: u32) -> Self {
        Self {
            stride,
            seen: 0,
            floor: 1,
            kept: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, p: PendingPoint) {
        self.seen += 1;
        let floor = thinning_lattice(self.seen).max(1);
        if floor > self.floor {
            self.floor = floor;
            self.kept.retain(|q| may_survive(q, self.stride, floor));
        }
        if may_survive(&p, self.stride, self.floor) {
            self.kept.push(p);
        }
    }

    /// The points [`thin_points`] keeps of everything pushed, in order:
    /// `floor` is by now the lattice the whole list implies.
    pub(crate) fn finish(mut self) -> Vec<PendingPoint> {
        self.kept.retain(|p| on_lattice(p, self.stride, self.floor));
        self.kept.shrink_to_fit();
        self.kept
    }

    #[cfg(test)]
    fn kept_len(&self) -> usize {
        self.kept.len()
    }
}

/// Whether some lattice of at least `floor` divides both grid indices.
fn may_survive(p: &PendingPoint, stride: u32, floor: u32) -> bool {
    let (gx, gy) = grid_index(p, stride);
    let g = gcd(gx, gy);
    g == 0 || g >= floor
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gain::overlap::{thin_points, DIRECTION_SAMPLE_CAP};

    fn point(gx: u32, gy: u32, stride: u32) -> PendingPoint {
        let at = |g: u32| (stride / 2 + g * stride) as f32 + 0.5;
        PendingPoint {
            pos_src: [at(gx), at(gy)],
            value_src: [gx as f32, gy as f32, 0.0],
            pos_dst: [0.0, 0.0],
        }
    }

    /// Pruned accumulation keeps exactly the points, in order, that
    /// thinning the whole list keeps, below the cap, at it and far above
    /// it, for odd and even strides and a list that skips grid points.
    #[test]
    fn pruned_points_equal_thinned_points() {
        for stride in [1, 4, 7] {
            for (w, h, skip) in [(40, 50, 3), (64, 64, 0), (65, 64, 0), (700, 420, 5)] {
                let all: Vec<_> = (0..h)
                    .flat_map(|y| (0..w).map(move |x| (x, y)))
                    .filter(|&(x, y)| skip == 0 || (x * 31 + y * 17) % 11 != skip)
                    .map(|(x, y)| point(x, y, stride))
                    .collect();
                let mut forward = ForwardPoints::new(stride);
                all.iter().for_each(|&p| forward.push(p));
                let want = format!("{:?}", thin_points(all, stride));
                assert_eq!(
                    format!("{:?}", forward.finish()),
                    want,
                    "{w}x{h} stride {stride}"
                );
            }
        }
    }

    /// A 100 MP frame's whole stride-4 grid (2,500 × 2,500 points) landing
    /// in one neighbour keeps under 2.5 % of its points at any moment, which
    /// needs the kept set re-pruned as the floor rises, not only on arrival.
    #[test]
    fn pruned_points_stay_far_below_the_grid() {
        let mut forward = ForwardPoints::new(4);
        let mut peak = 0;
        for y in 0..2500 {
            for x in 0..2500 {
                forward.push(point(x, y, 4));
            }
            peak = peak.max(forward.kept_len());
        }
        assert!(peak < 6_250_000 / 40, "kept {peak} points");
        assert!(forward.finish().len() <= DIRECTION_SAMPLE_CAP);
    }
}

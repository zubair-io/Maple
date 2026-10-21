//! DNG `MapPolynomial` (opcode 8): a per-plane polynomial transfer over an
//! ActiveArea-relative rectangle, evaluated on values normalised to [0, 1].
//! Lossy DNGs declare their linearisation this way in OpcodeList2 (#4629).
use super::Cursor;

/// The DNG spec caps the degree at 8.
const MAXIMUM_DEGREE: u32 = 8;

#[derive(Clone, Debug, PartialEq)]
pub struct MapPolynomialOpcode {
    pub top: u32,
    pub bottom: u32,
    pub left: u32,
    pub right: u32,
    pub plane: u32,
    pub planes: u32,
    pub row_pitch: u32,
    pub col_pitch: u32,
    /// `c[0] + c[1]·x + … + c[degree]·x^degree`.
    pub coefficients: Vec<f64>,
    /// `flags` bit 0 clear; set by the list parser, which owns the flags.
    pub required: bool,
}

impl MapPolynomialOpcode {
    pub fn covers(&self, x: u32, y: u32, plane: u32) -> bool {
        x >= self.left
            && x < self.right
            && y >= self.top
            && y < self.bottom
            && (x - self.left) % self.col_pitch == 0
            && (y - self.top) % self.row_pitch == 0
            && plane >= self.plane
            && plane - self.plane < self.planes
    }

    /// dng_sdk works on values in [0, 1] and pins the result to [0, 1].
    pub fn evaluate(&self, value: f32) -> f32 {
        self.at(f64::from(value).clamp(0., 1.)).clamp(0., 1.) as f32
    }

    /// Bounds on [`Self::evaluate`] over inputs in `[low, high]`: the extremes
    /// of a dense sampling widened by the most the curve can move between
    /// samples (its slope bound on [0, 1] times half the spacing).
    pub fn range_over(&self, low: f32, high: f32) -> (f32, f32) {
        const SAMPLES: usize = 256;
        let (a, b) = (f64::from(low).clamp(0., 1.), f64::from(high).clamp(0., 1.));
        let step = (b - a) / (SAMPLES - 1) as f64;
        let slope: f64 = self
            .coefficients
            .iter()
            .enumerate()
            .map(|(k, c)| k as f64 * c.abs())
            .sum();
        let (min, max) = (0..SAMPLES)
            .map(|i| self.at(a + step * i as f64))
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), y| {
                (lo.min(y), hi.max(y))
            });
        let slack = slope * step * 0.5;
        (
            (min - slack).clamp(0., 1.) as f32,
            (max + slack).clamp(0., 1.) as f32,
        )
    }

    fn at(&self, x: f64) -> f64 {
        self.coefficients
            .iter()
            .rev()
            .fold(0., |sum, c| sum * x + c)
    }
}

pub(super) fn parse(cur: &mut Cursor<'_>, param_len: usize) -> Option<MapPolynomialOpcode> {
    let [top, left, bottom, right, plane, planes, row_pitch, col_pitch, degree] =
        [(); 9].map(|_| cur.read_u32());
    let (top, left, bottom, right) = (top?, left?, bottom?, right?);
    let (plane, planes, row_pitch, col_pitch, degree) =
        (plane?, planes?, row_pitch?, col_pitch?, degree?);
    if degree > MAXIMUM_DEGREE || param_len != 36 + 8 * (degree as usize + 1) {
        return None;
    }
    if planes == 0 || row_pitch == 0 || col_pitch == 0 || bottom <= top || right <= left {
        return None;
    }
    let coefficients = (0..=degree)
        .map(|_| cur.read_f64().filter(|c| c.is_finite()))
        .collect::<Option<Vec<_>>>()?;
    Some(MapPolynomialOpcode {
        top,
        bottom,
        left,
        right,
        plane,
        planes,
        row_pitch,
        col_pitch,
        coefficients,
        required: true,
    })
}

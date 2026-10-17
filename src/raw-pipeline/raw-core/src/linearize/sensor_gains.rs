//! Coordinate transport for Bayer sensor calibration and saturation ceilings.
//! Gain changes radiance, not whether a photosite saturated. Missing-channel
//! ceilings interpolate the same CFA phase locally; the measured phase stays
//! exact. Half-resolution previews use their actual 2x2 sample footprint.
use super::GainMaps;
use crate::image::{CfaPattern, RawImage};
use crate::stages::lateral_ca::CaCalibration;

#[derive(Clone, Copy)]
pub(crate) struct SensorGains<'a> {
    maps: &'a GainMaps,
    cfa: CfaPattern,
    size: (u32, u32),
    active: (i32, i32, u32, u32),
    origin: (u32, u32),
    divisor: u32,
    ca: Option<CaCalibration>,
}

impl<'a> SensorGains<'a> {
    pub(crate) fn for_raw(raw: &'a RawImage, origin: (u32, u32), divisor: u32) -> Option<Self> {
        let maps = raw.sensor_gain_maps.as_ref()?;
        debug_assert!(raw.cfa.is_bayer_2x2());
        debug_assert!(divisor == 1 || divisor == 2);
        let active = raw
            .lens_metadata
            .active_area
            .map_or((0, 0, raw.width, raw.height), |a| {
                (a.left as i32, a.top as i32, a.width, a.height)
            });
        Some(Self {
            maps,
            cfa: raw.cfa,
            size: (raw.width, raw.height),
            active,
            origin,
            divisor,
            ca: None,
        })
    }

    pub(crate) fn with_ca(self, ca: Option<CaCalibration>) -> Self {
        Self { ca, ..self }
    }

    pub(crate) fn at_resolution(self, divisor: u32) -> Self {
        debug_assert!(divisor == 1 || divisor == 2);
        Self { divisor, ..self }
    }

    /// Absolute sensor coordinate. Reflect missing border witnesses while
    /// retaining Bayer phase, exactly as the demosaic border extension does.
    pub(crate) fn sample(self, x: i32, y: i32) -> f32 {
        let mirror = |v: i32, n: u32| {
            if n < 2 {
                return 0;
            }
            let period = 2 * (i64::from(n) - 1);
            let q = i64::from(v).rem_euclid(period);
            q.min(period - q) as i32
        };
        let (x, y) = (mirror(x, self.size.0), mirror(y, self.size.1));
        let Some((fx, fy)) = self
            .ca
            .and_then(|ca| ca.source(self.cfa.color_at(x as u32, y as u32), x as u32, y as u32))
        else {
            return self.uncorrected(x, y);
        };
        // Bayer R/B are rectangular stride-two lattices. Reproduce the
        // channel sampler's clamping, taps and delta-form interpolation;
        // do not resample across different CFA phases or allocate a raster.
        let (ox, oy) = (x % 2, y % 2);
        let cols = (self.size.0 - ox as u32).div_ceil(2);
        let rows = (self.size.1 - oy as u32).div_ceil(2);
        let u = ((fx - ox as f32) / 2.0).clamp(0.0, (cols - 1) as f32);
        let v = ((fy - oy as f32) / 2.0).clamp(0.0, (rows - 1) as f32);
        let (u0, v0) = (u.floor() as u32, v.floor() as u32);
        let (u1, v1) = ((u0 + 1).min(cols - 1), (v0 + 1).min(rows - 1));
        let tap = |u, v| self.uncorrected(ox + 2 * u as i32, oy + 2 * v as i32);
        let (a, b, c, d) = (tap(u0, v0), tap(u1, v0), tap(u0, v1), tap(u1, v1));
        let top = a + (b - a) * (u - u0 as f32);
        let bot = c + (d - c) * (u - u0 as f32);
        let here = self.uncorrected(x, y);
        here + (top + (bot - top) * (v - v0 as f32) - here)
    }

    fn uncorrected(self, x: i32, y: i32) -> f32 {
        let (left, top, width, height) = self.active;
        let (x, y) = (x - left, y - top);
        if x < 0 || y < 0 || x as u32 >= width || y as u32 >= height {
            return 1.0;
        }
        self.maps.gain(x, y, width, height)
    }

    pub(crate) fn rgb(self, x: u32, y: u32) -> [f32; 3] {
        let (x, y) = (
            self.origin.0 + x * self.divisor,
            self.origin.1 + y * self.divisor,
        );
        if self.divisor == 2 {
            let mut gains = [0.0; 3];
            for dy in 0..2 {
                for dx in 0..2 {
                    let c = self.cfa.color_at(x + dx, y + dy) as usize;
                    gains[c] += self.sample((x + dx) as i32, (y + dy) as i32)
                        * if c == 1 { 0.5 } else { 1.0 };
                }
            }
            return gains;
        }
        let sampled = self.cfa.color_at(x, y) as usize;
        let (x, y) = (x as i32, y as i32);
        std::array::from_fn(|c| {
            if c == sampled {
                return self.sample(x, y);
            }
            if c == 1 {
                return (self.sample(x - 1, y)
                    + self.sample(x + 1, y)
                    + self.sample(x, y - 1)
                    + self.sample(x, y + 1))
                    * 0.25;
            }
            // Red/blue occupy one parity pair. Average the two bracketing
            // photosites only along axes where this pixel lacks that phase.
            let phase = (0..4)
                .find(|i| self.cfa.color_at(i % 2, i / 2) as usize == c)
                .unwrap();
            let dx = i32::from(x.rem_euclid(2) != (phase % 2) as i32);
            let dy = i32::from(y.rem_euclid(2) != (phase / 2) as i32);
            (self.sample(x - dx, y - dy)
                + self.sample(x + dx, y - dy)
                + self.sample(x - dx, y + dy)
                + self.sample(x + dx, y + dy))
                * 0.25
        })
    }

    pub(crate) fn scale(self, levels: [f32; 3], x: u32, y: u32) -> [f32; 3] {
        let g = self.rgb(x, y);
        std::array::from_fn(|c| levels[c] * g[c])
    }
}

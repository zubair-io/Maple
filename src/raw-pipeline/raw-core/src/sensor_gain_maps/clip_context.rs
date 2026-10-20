use crate::image::{CfaPattern, RawImage};
use rayon::prelude::*;

#[derive(Clone, Copy)]
pub(crate) struct ClipGainContext<'a> {
    raw: &'a RawImage,
    origin: (u32, u32),
    divisor: u32,
    minimum_scale: f32,
}

impl<'a> ClipGainContext<'a> {
    pub(crate) fn new(raw: &'a RawImage, origin: (u32, u32), divisor: u32) -> Option<Self> {
        let maps = raw.sensor_gain_maps.as_ref()?;
        let minimum: f32 = maps
            .maps
            .iter()
            .map(|map| map.gains.iter().copied().fold(1., f32::min))
            .product();
        Some(Self {
            raw,
            origin,
            divisor: divisor.max(1),
            minimum_scale: (minimum * (1. - 1e-6)).max(0.),
        })
    }

    /// Each site's own gain over a full-resolution `width × height` window,
    /// exactly as `sensor_linearize` applied it.
    pub(crate) fn site_gains(self, width: u32, height: u32) -> Vec<f32> {
        let maps = self
            .raw
            .sensor_gain_maps
            .as_ref()
            .expect("ClipGainContext is only constructed with sensor gain maps");
        (0..width as usize * height as usize)
            .into_par_iter()
            .map(|i| {
                let (x, y) = (i as u32 % width, i as u32 / width);
                maps.gain_at(self.origin.0 + x, self.origin.1 + y, 0)
            })
            .collect()
    }

    pub(crate) fn minimum_scale(self) -> f32 {
        self.minimum_scale
    }

    pub(crate) fn scale(self, index: usize, width: u32) -> [f32; 3] {
        let maps = self.raw.sensor_gain_maps.as_ref().unwrap();
        let x = self.origin.0 + index as u32 % width * self.divisor;
        let y = self.origin.1 + index as u32 / width * self.divisor;
        if self.raw.cfa == CfaPattern::LinearRgb {
            return std::array::from_fn(|c| maps.gain_at(x, y, c as u32));
        }
        let period = if self.raw.cfa.is_xtrans() { 6 } else { 2 };
        let mut sum = [0.; 3];
        let mut count = [0u32; 3];
        for py in 0..period.min(self.raw.height) {
            for px in 0..period.min(self.raw.width) {
                let c = self.raw.cfa.color_at(px, py) as usize;
                let gain = if self.divisor == 2 && period == 2 {
                    maps.gain_at(x + px, y + py, 0)
                } else {
                    let (x0, x1, fx) = phase_span(x, px, period, self.raw.width);
                    let (y0, y1, fy) = phase_span(y, py, period, self.raw.height);
                    let a = maps.gain_at(x0, y0, 0);
                    let b = maps.gain_at(x1, y0, 0);
                    let d = maps.gain_at(x0, y1, 0);
                    let e = maps.gain_at(x1, y1, 0);
                    let top = a + (b - a) * fx;
                    let bottom = d + (e - d) * fx;
                    top + (bottom - top) * fy
                };
                sum[c] += gain;
                count[c] += 1;
            }
        }
        let mut gains = std::array::from_fn(|c| {
            if count[c] > 0 {
                sum[c] / count[c] as f32
            } else {
                1.
            }
        });
        if self.divisor == 1 {
            let c = self.raw.cfa.color_at(x, y) as usize;
            gains[c] = maps.gain_at(x, y, 0);
        }
        gains
    }
}

fn phase_span(position: u32, phase: u32, period: u32, extent: u32) -> (u32, u32, f32) {
    let coordinate = (f64::from(position) - f64::from(phase)) / f64::from(period);
    let lower = coordinate.floor();
    let last = phase + (extent - 1 - phase) / period * period;
    let sample = |index: f64| {
        (index * f64::from(period) + f64::from(phase)).clamp(f64::from(phase), f64::from(last))
            as u32
    };
    (
        sample(lower),
        sample(lower + 1.),
        (coordinate - lower) as f32,
    )
}

//! #3941 research only: invertible photographic contrast over the pinned
//! signed-log domain. Scene black maps to 0.03; negative channels keep a
//! separate monotonic interval below black. No gamut compression or clipping.
//! This is not a production recipe or a develop-chain/view-transform change.

use raw_core::color::matrices::{M_REC2020_TO_SRGB, M_SRGB_TO_REC2020};
use raw_core::math::Matrix3;
use serde::{Deserialize, Serialize};

type ProbeResult<T> = Result<T, Box<dyn std::error::Error>>;
const METHOD: &str = "signed-log-photographic-contrast-v1";
const BLACK: f32 = 0.03;
const SCALE: f64 = 0.18;
const MARGIN: f64 = 0.015;
const GAMMA: f64 = 2.2;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhotographicContrast {
    method: String,
    low: f64,
    high: f64,
}

fn rotate(matrix: Matrix3, pixel: [f64; 3]) -> [f64; 3] {
    matrix.0.map(|row| {
        row.into_iter()
            .zip(pixel)
            .map(|(coefficient, value)| f64::from(coefficient) * value)
            .sum()
    })
}

impl PhotographicContrast {
    pub fn fit(scene: &[[f32; 3]]) -> ProbeResult<Self> {
        if scene.is_empty() || scene.iter().flatten().any(|v| !v.is_finite()) {
            return Err("invalid photographic contrast scene".into());
        }
        // Reference white and a negative reserve make flat scenes usable.
        let mut low = (-1.0_f64).asinh();
        let mut high = (1.0 / SCALE).asinh();
        for pixel in scene {
            for value in rotate(M_REC2020_TO_SRGB, pixel.map(f64::from)) {
                let log = (value / SCALE).asinh();
                low = low.min(log);
                high = high.max(log);
            }
        }
        let recipe = Self {
            method: METHOD.into(),
            low,
            high,
        };
        recipe.validate()?;
        Ok(recipe)
    }

    pub fn validate(&self) -> ProbeResult<()> {
        if self.method != METHOD {
            return Err("unsupported photographic contrast recipe".into());
        }
        if !self.low.is_finite()
            || !self.high.is_finite()
            || self.low > (-1.0_f64).asinh()
            || self.high < (1.0 / SCALE).asinh()
            || self.low < -100.0
            || self.high > 100.0
        {
            return Err("invalid photographic contrast range".into());
        }
        Ok(())
    }

    pub fn encode(&self, scene: &[[f32; 3]]) -> ProbeResult<Vec<[f32; 3]>> {
        self.validate()?;
        let black = f64::from(BLACK);
        scene
            .iter()
            .map(|pixel| {
                if pixel.iter().any(|v| !v.is_finite()) {
                    return Err("nonfinite photographic contrast scene sample".into());
                }
                // Compose the range and gamma in f64, with just one final
                // f32 cast. Re-encoding a float32 signed-log intermediate
                // exceeded the HDR identity bound in the initial experiment.
                let photographic = rotate(M_REC2020_TO_SRGB, pixel.map(f64::from)).map(|value| {
                    let log = (value / SCALE).asinh();
                    let mapped = if log <= 0.0 {
                        black + (black - MARGIN) * log / -self.low
                    } else {
                        black + (1.0 - MARGIN - black) * (log / self.high).powf(1.0 / GAMMA)
                    };
                    mapped as f32
                });
                if photographic.iter().all(|v| (0.0..=1.0).contains(v)) {
                    Ok(photographic)
                } else {
                    Err("photographic contrast exceeds model domain".into())
                }
            })
            .collect()
    }

    pub fn decode(&self, model: &[[f32; 3]]) -> ProbeResult<Vec<[f32; 3]>> {
        self.validate()?;
        let black = f64::from(BLACK);
        if model.iter().flatten().any(|v| !(0.0..=1.0).contains(v)) {
            return Err("invalid photographic contrast model sample".into());
        }
        model
            .iter()
            .map(|pixel| {
                let linear = pixel.map(|value| {
                    let value = f64::from(value);
                    let log = if value <= black {
                        -self.low * (value - black) / (black - MARGIN)
                    } else {
                        self.high * ((value - black) / (1.0 - MARGIN - black)).powf(GAMMA)
                    };
                    SCALE * log.sinh()
                });
                let scene = rotate(M_SRGB_TO_REC2020, linear).map(|v| v as f32);
                if scene.iter().all(|v| v.is_finite()) {
                    Ok(scene)
                } else {
                    Err("photographic contrast inverse overflows scene RGB".into())
                }
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "photographic_encoding_tests.rs"]
mod tests;

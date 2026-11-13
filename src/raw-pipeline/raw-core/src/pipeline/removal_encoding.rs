//! Reversible photographic encoding experiment for #3941.
//!
//! This is an authoring/probe operation, never a develop-chain stage. It
//! consumes a fixed scene-linear context, not a graded display preview.
//! The common signed-log range retains negative channels and HDR values.
//! Model quality in this domain must be qualified before editor use (#1472).

use crate::color::matrices::{M_REC2020_TO_SRGB, M_SRGB_TO_REC2020};
use crate::error::{Error, Result};
use crate::math::Matrix3;
use serde::{Deserialize, Serialize};

const SCALE: f64 = 0.18;
const MARGIN: f64 = 0.015;

/// Exact per-context recipe; serialized alongside model-probe results.
/// Private fields prevent unchecked construction by hosts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemovalModelEncoding {
    version: u32,
    low: f64,
    span: f64,
}

fn invalid(reason: &str) -> Error {
    Error::Pipeline(format!("removal model encoding: {reason}"))
}

fn rotate(matrix: Matrix3, pixel: [f32; 3]) -> [f64; 3] {
    matrix.0.map(|row| {
        row.into_iter()
            .zip(pixel)
            .map(|(coefficient, value)| f64::from(coefficient) * f64::from(value))
            .sum()
    })
}

impl RemovalModelEncoding {
    /// Fit one range shared by RGB. Include scene black and reference white
    /// so a flat context still has a useful, neutral-preserving range.
    /// No source channel is clipped or quantized.
    pub fn fit(scene: &[[f32; 3]]) -> Result<Self> {
        if scene.is_empty() {
            return Err(invalid("empty context"));
        }
        let mut low = 0.0_f64;
        let mut high = (1.0 / SCALE).asinh();
        for pixel in scene {
            if !pixel.iter().all(|value| value.is_finite()) {
                return Err(invalid("non-finite scene input"));
            }
            for value in rotate(M_REC2020_TO_SRGB, *pixel) {
                let log = (value / SCALE).asinh();
                low = low.min(log);
                high = high.max(log);
            }
        }
        let encoding = Self {
            version: 1,
            low,
            span: high - low,
        };
        encoding.validate()?;
        Ok(encoding)
    }

    /// Validate loaded recipes before either direction performs any math.
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(invalid("unsupported recipe version"));
        }
        if !self.low.is_finite()
            || !self.span.is_finite()
            || self.span <= 0.0
            || self.low > 0.0
            || self.low + self.span < (1.0 / SCALE).asinh()
            || self.low.abs() > 100.0
            || self.span > 200.0
        {
            return Err(invalid("invalid signed-log range"));
        }
        Ok(())
    }

    /// Float photographic RGB in [0,1], with reserve for model-generated
    /// samples beyond the observed range. Out-of-context pixels error;
    /// silently squeezing/clipping them would change the saved recipe.
    pub fn encode(&self, scene: &[[f32; 3]]) -> Result<Vec<[f32; 3]>> {
        self.validate()?;
        scene
            .iter()
            .map(|pixel| {
                if !pixel.iter().all(|value| value.is_finite()) {
                    return Err(invalid("non-finite scene input"));
                }
                let encoded = rotate(M_REC2020_TO_SRGB, *pixel).map(|value| {
                    (MARGIN
                        + (1.0 - 2.0 * MARGIN) * ((value / SCALE).asinh() - self.low) / self.span)
                        as f32
                });
                if encoded.iter().all(|value| (0.0..=1.0).contains(value)) {
                    Ok(encoded)
                } else {
                    Err(invalid("scene input exceeds recipe domain"))
                }
            })
            .collect()
    }

    /// Return model samples to unbounded Rec.2020 scene RGB. NaN, values
    /// outside the model domain, or overflow fail rather than being clipped.
    pub fn decode(&self, model: &[[f32; 3]]) -> Result<Vec<[f32; 3]>> {
        self.validate()?;
        model
            .iter()
            .map(|pixel| {
                if !pixel.iter().all(|value| (0.0..=1.0).contains(value)) {
                    return Err(invalid("invalid model sample"));
                }
                let linear = pixel.map(|value| {
                    SCALE
                        * (self.low
                            + self.span * (f64::from(value) - MARGIN) / (1.0 - 2.0 * MARGIN))
                            .sinh()
                });
                let scene = M_SRGB_TO_REC2020.0.map(|row| {
                    row.into_iter()
                        .zip(linear)
                        .map(|(coefficient, value)| f64::from(coefficient) * value)
                        .sum::<f64>() as f32
                });
                if scene.iter().all(|value| value.is_finite()) {
                    Ok(scene)
                } else {
                    Err(invalid("model sample overflows scene RGB"))
                }
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "removal_encoding_tests.rs"]
mod tests;

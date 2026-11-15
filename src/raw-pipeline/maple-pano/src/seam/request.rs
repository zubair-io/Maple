use serde::{Deserialize, Serialize};

use super::{CanvasRect, SeamConstraint, SeamConstraintError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeamConstraintsRequest {
    pub version: u32,
    pub canvas: SeamConstraintCanvas,
    pub regions: Vec<SeamRegion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeamConstraintCanvas {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeamRegionKind {
    Include,
    Exclude,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeamRegion {
    pub kind: SeamRegionKind,
    pub frame: usize,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl SeamConstraintsRequest {
    pub const VERSION: u32 = 1;

    pub fn parse(json: &str, frames: usize) -> Result<Self, SeamConstraintError> {
        let request: Self = serde_json::from_str(json)
            .map_err(|e| SeamConstraintError::InvalidRequest(e.to_string()))?;
        request.validate(frames)?;
        Ok(request)
    }

    pub fn validate(&self, frames: usize) -> Result<(), SeamConstraintError> {
        if self.version != Self::VERSION {
            return Err(SeamConstraintError::UnsupportedVersion(self.version));
        }
        if self.canvas.width == 0 || self.canvas.height == 0 {
            return Err(SeamConstraintError::InvalidRequest(
                "canvas dimensions must be positive".into(),
            ));
        }
        for region in &self.regions {
            if region.frame >= frames {
                return Err(SeamConstraintError::UnknownFrame {
                    frame: region.frame,
                    frames,
                });
            }
            if region.width == 0
                || region.height == 0
                || region
                    .x
                    .checked_add(region.width)
                    .is_none_or(|x| x > self.canvas.width)
                || region
                    .y
                    .checked_add(region.height)
                    .is_none_or(|y| y > self.canvas.height)
            {
                return Err(SeamConstraintError::InvalidRequest(
                    "regions must be non-empty rectangles with non-overflowing u32 coordinates"
                        .into(),
                ));
            }
        }
        Ok(())
    }

    pub fn constraints(&self) -> Vec<SeamConstraint> {
        self.regions
            .iter()
            .map(|r| {
                let rect = CanvasRect {
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: r.height,
                };
                match r.kind {
                    SeamRegionKind::Include => SeamConstraint::ForceInclude(r.frame, rect),
                    SeamRegionKind::Exclude => SeamConstraint::ForceExclude(r.frame, rect),
                }
            })
            .collect()
    }

    pub fn for_canvas(&self, width: u32, height: u32) -> impl Iterator<Item = SeamConstraint> + '_ {
        let low = |value: u32, extent: u32, reference: u32| {
            (u64::from(value) * u64::from(extent) / u64::from(reference)) as u32
        };
        let high = |value: u32, extent: u32, reference: u32| {
            (u64::from(value) * u64::from(extent)).div_ceil(u64::from(reference)) as u32
        };
        self.regions.iter().map(move |r| {
            let x = low(r.x, width, self.canvas.width);
            let y = low(r.y, height, self.canvas.height);
            let rect = CanvasRect {
                x,
                y,
                width: high(r.x + r.width, width, self.canvas.width) - x,
                height: high(r.y + r.height, height, self.canvas.height) - y,
            };
            match r.kind {
                SeamRegionKind::Include => SeamConstraint::ForceInclude(r.frame, rect),
                SeamRegionKind::Exclude => SeamConstraint::ForceExclude(r.frame, rect),
            }
        })
    }

    pub fn from_constraints(constraints: &[SeamConstraint], canvas: SeamConstraintCanvas) -> Self {
        Self {
            version: 1,
            canvas,
            regions: constraints
                .iter()
                .map(|c| {
                    let rect = c.rect();
                    SeamRegion {
                        kind: match c {
                            SeamConstraint::ForceInclude(..) => SeamRegionKind::Include,
                            SeamConstraint::ForceExclude(..) => SeamRegionKind::Exclude,
                        },
                        frame: c.frame(),
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                    }
                })
                .collect(),
        }
    }
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;

//! Native source-window intent masks for AI removal (#3934, epic #1472).
//! These are selection data, not graded-image alpha or display coordinates.

/// Binary selection inside a half-open native DefaultCrop source rectangle.
/// Source coordinates precede EXIF orientation and presentation transforms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemovalMask {
    pub source_width: u32,
    pub source_height: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// Row-major: 255 means remove, 0 means keep. Feathering belongs to the
    /// separately generated patch coverage, never to this intent mask.
    pub pixels: Vec<u8>,
}

impl RemovalMask {
    pub fn validate(&self) -> Result<(), String> {
        let n = validate_mask_layout(
            self.source_width,
            self.source_height,
            self.x,
            self.y,
            self.width,
            self.height,
        )?;
        if self.pixels.len() != n || self.pixels.iter().any(|v| *v != 0 && *v != 255) {
            return Err("removal mask: body must match dimensions and contain only 0/255".into());
        }
        Ok(())
    }
}

pub(crate) fn validate_mask_layout(
    source_width: u32,
    source_height: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<usize, String> {
    if source_width == 0
        || source_height == 0
        || width == 0
        || height == 0
        || x.checked_add(width).is_none_or(|end| end > source_width)
        || y.checked_add(height).is_none_or(|end| end > source_height)
    {
        return Err("removal mask: non-empty window must fit the native source".into());
    }
    (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| "removal mask: dimension overflow".to_string())
}

/// One continuous Paint/Subtract gesture. Points and radius are normalized to
/// the source; radius is a fraction of source WIDTH, so circles stay circular.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemovalStroke {
    pub points: Vec<[f32; 2]>,
    pub radius: f32,
    pub subtract: bool,
}

impl RemovalStroke {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !self.radius.is_finite()
            || self.radius <= 0.0
            || self.radius > 1.0
            || self.points.is_empty()
            || self
                .points
                .iter()
                .flatten()
                .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
        {
            return Err("removal stroke: finite source points and positive radius required".into());
        }
        Ok(())
    }
}

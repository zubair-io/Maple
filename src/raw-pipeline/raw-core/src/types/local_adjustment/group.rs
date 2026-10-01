//! Ordered leaf-mask composition (#3408). Geometry remains editable per
//! component; adjustments and range refinement belong to the containing layer.

use super::Mask;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum MaskCombine {
    Add = 0,
    Subtract = 1,
    Intersect = 2,
}

impl MaskCombine {
    pub const ALL: [Self; 3] = [Self::Add, Self::Subtract, Self::Intersect];

    pub const fn name(self) -> &'static str {
        match self {
            Self::Add => "Add",
            Self::Subtract => "Subtract",
            Self::Intersect => "Intersect",
        }
    }
    /// Compose soft coverage without clipping scene-referred image values.
    /// Only these scalar selection weights are bounded to [0, 1].
    pub fn weight(self, accumulated: f32, component: f32) -> f32 {
        match self {
            Self::Add => accumulated + (1.0 - accumulated) * component,
            Self::Subtract => accumulated * (1.0 - component),
            Self::Intersect => accumulated * component,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MaskComponent {
    mask: Mask,
    pub combine: MaskCombine,
    pub invert: bool,
}

impl MaskComponent {
    /// Reject nested groups: the current contract is an ordered list of
    /// component shapes, not a recursive expression tree.
    pub fn new(mask: Mask, combine: MaskCombine, invert: bool) -> Option<Self> {
        (!matches!(mask, Mask::Group(_))).then_some(Self {
            mask,
            combine,
            invert,
        })
    }

    pub fn mask(&self) -> &Mask {
        &self.mask
    }

    pub fn into_mask(self) -> Mask {
        self.mask
    }

    pub fn set_raster_id(&mut self, id: u32) {
        if let Mask::Bitmap { raster_id, .. } = &mut self.mask {
            *raster_id = id;
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MaskGroup {
    pub components: Vec<MaskComponent>,
    /// Scales the final selection weight, independently of adjustment values.
    pub opacity: f32,
    pub invert: bool,
}

impl MaskGroup {
    pub fn new(components: Vec<MaskComponent>) -> Self {
        Self {
            components,
            opacity: 1.0,
            invert: false,
        }
    }

    pub fn finish_weight(&self, weight: f32) -> f32 {
        if self.components.is_empty() || !self.opacity.is_finite() {
            return 0.0;
        }
        let coverage = if self.invert { 1.0 - weight } else { weight };
        coverage.clamp(0.0, 1.0) * self.opacity.clamp(0.0, 1.0)
    }
}

#[cfg(test)]
#[path = "group_tests.rs"]
mod tests;

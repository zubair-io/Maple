//! Manual geometry for #2435. Coordinates are normalized to the display frame.
//! Masks stay in the original frame; this final inverse warp moves their rendered
//! pixels together with the image. Crop is evaluated after this transform.

use crate::image::{ExifOrientation, Image};

/// Explicit manual controls. Positive rotation is clockwise in image coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub perspective_h: f32,
    pub perspective_v: f32,
    pub rotation: f32,
    pub aspect: f32,
    pub scale: f32,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            perspective_h: 0.0,
            perspective_v: 0.0,
            rotation: 0.0,
            aspect: 1.0,
            scale: 1.0,
        }
    }
}

impl From<&crate::types::AdjustmentModel> for Geometry {
    fn from(model: &crate::types::AdjustmentModel) -> Self {
        Self {
            perspective_h: model.geo_perspective_h,
            perspective_v: model.geo_perspective_v,
            rotation: model.geo_rotation,
            aspect: model.geo_aspect,
            scale: model.geo_scale,
        }
    }
}

/// Row-major homogeneous transform, shared with GPU uniforms and host hit testing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform(pub [[f32; 3]; 3]);

impl Transform {
    pub const IDENTITY: Self = Self([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);

    pub fn point(self, x: f32, y: f32) -> Option<[f32; 2]> {
        let m = self.0;
        let z = m[2][0] * x + m[2][1] * y + m[2][2];
        if !z.is_finite() || z <= 1e-6 {
            return None;
        }
        let p = [
            (m[0][0] * x + m[0][1] * y + m[0][2]) / z,
            (m[1][0] * x + m[1][1] * y + m[1][2]) / z,
        ];
        p.iter().all(|v| v.is_finite()).then_some(p)
    }

    /// Compose `self` after `rhs`.
    pub fn compose(self, rhs: Self) -> Self {
        let mut out = [[0.0; 3]; 3];
        for (r, row) in out.iter_mut().enumerate() {
            for (c, value) in row.iter_mut().enumerate() {
                *value = (0..3).map(|k| self.0[r][k] * rhs.0[k][c]).sum();
            }
        }
        Self(out)
    }

    pub fn inverse(self) -> Option<Self> {
        let [[a, b, c], [d, e, f], [g, h, i]] = self.0;
        let determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
        if !determinant.is_finite() || determinant.abs() < 1e-8 {
            return None;
        }
        let mut m = [
            [e * i - f * h, c * h - b * i, b * f - c * e],
            [f * g - d * i, a * i - c * g, c * d - a * f],
            [d * h - e * g, b * g - a * h, a * e - b * d],
        ];
        for row in &mut m {
            for value in row {
                *value /= determinant;
            }
        }
        Some(Self(m))
    }
}

impl Geometry {
    /// Output-to-source sampling in sensor framing, while controls retain their
    /// display-oriented meaning. Hosts with already-oriented buffers use Normal.
    pub fn inverse_sensor(
        self,
        width: u32,
        height: u32,
        orientation: ExifOrientation,
    ) -> Result<Transform, &'static str> {
        let (dw, dh) = if orientation.swaps_wh() {
            (height, width)
        } else {
            (width, height)
        };
        let forward = self.forward(dw, dh)?;
        if forward == Transform::IDENTITY {
            return Ok(forward);
        }
        let orient = orientation_transform(orientation);
        let inverse = forward.inverse().ok_or("manual geometry is singular")?;
        Ok(orient
            .inverse()
            .ok_or("orientation is singular")?
            .compose(inverse)
            .compose(orient))
    }

    /// Source-to-output mapping in normalized display coordinates. The bounded
    /// perspective keeps the source rectangle in front of the projective plane.
    /// Invalid authored values are rejected, never silently converted to identity.
    pub fn forward(self, width: u32, height: u32) -> Result<Transform, &'static str> {
        if width == 0 || height == 0 {
            return Err("geometry requires nonzero dimensions");
        }
        if !(-0.4..=0.4).contains(&self.perspective_h)
            || !(-0.4..=0.4).contains(&self.perspective_v)
            || !(-180.0..=180.0).contains(&self.rotation)
            || !(0.5..=2.0).contains(&self.aspect)
            || !(0.25..=4.0).contains(&self.scale)
        {
            return Err("manual geometry is outside its supported range");
        }
        if self == Self::default() {
            return Ok(Transform::IDENTITY);
        }
        let (sin, cos) = self.rotation.to_radians().sin_cos();
        let ratio = width as f32 / height as f32;
        let ax = self.scale * self.aspect.sqrt();
        let ay = self.scale / self.aspect.sqrt();
        let centered = Transform([
            [cos * ax, -sin * ay / ratio, 0.0],
            [sin * ax * ratio, cos * ay, 0.0],
            [self.perspective_h, self.perspective_v, 1.0],
        ]);
        let center = Transform([[2.0, 0.0, -1.0], [0.0, 2.0, -1.0], [0.0, 0.0, 1.0]]);
        let uncenter = Transform([[0.5, 0.0, 0.5], [0.0, 0.5, 0.5], [0.0, 0.0, 1.0]]);
        Ok(uncenter.compose(centered).compose(center))
    }
}

/// Sensor-to-display orientation of normalized frame edges (EXIF 1 through 8).
pub fn orientation_transform(orientation: ExifOrientation) -> Transform {
    use ExifOrientation::*;
    Transform(match orientation {
        Normal => Transform::IDENTITY.0,
        HorizontalFlip => [[-1.0, 0.0, 1.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        Rotate180 => [[-1.0, 0.0, 1.0], [0.0, -1.0, 1.0], [0.0, 0.0, 1.0]],
        VerticalFlip => [[1.0, 0.0, 0.0], [0.0, -1.0, 1.0], [0.0, 0.0, 1.0]],
        Transpose => [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
        Rotate90 => [[0.0, -1.0, 1.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
        Transverse => [[0.0, -1.0, 1.0], [-1.0, 0.0, 1.0], [0.0, 0.0, 1.0]],
        Rotate270 => [[0.0, 1.0, 0.0], [-1.0, 0.0, 1.0], [0.0, 0.0, 1.0]],
    })
}

/// Apply an output-to-source matrix before quantization. The caller supplies
/// reusable scratch storage; identity preserves the original pixel allocation.
pub fn apply(image: &mut Image, inverse: Transform, scratch: &mut Vec<[f32; 3]>) {
    if inverse == Transform::IDENTITY {
        return;
    }
    let (w, h) = (image.width as usize, image.height as usize);
    scratch.resize(image.pixels.len(), [0.0; 3]);
    apply_into(&image.pixels, scratch, w, h, inverse);
    std::mem::swap(&mut image.pixels, scratch);
}

/// Allocation-free RGB/RGBA sampling into a separate, caller-owned buffer.
pub fn apply_into<const N: usize>(
    source: &[[f32; N]],
    scratch: &mut [[f32; N]],
    w: usize,
    h: usize,
    inverse: Transform,
) {
    assert_eq!(source.len(), w * h);
    assert_eq!(scratch.len(), source.len());
    for (index, pixel) in scratch.iter_mut().enumerate() {
        *pixel = [0.0; N];
        let Some([u, v]) = inverse.point(
            (index % w) as f32 / w as f32 + 0.5 / w as f32,
            (index / w) as f32 / h as f32 + 0.5 / h as f32,
        ) else {
            continue;
        };
        if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) {
            continue;
        }
        let x = (u * w as f32 - 0.5).clamp(0.0, (w - 1) as f32);
        let y = (v * h as f32 - 0.5).clamp(0.0, (h - 1) as f32);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let (tx, ty) = (x - x0 as f32, y - y0 as f32);
        for (c, value) in pixel.iter_mut().enumerate() {
            let top = source[y0 * w + x0][c] * (1.0 - tx) + source[y0 * w + x1][c] * tx;
            let bottom = source[y1 * w + x0][c] * (1.0 - tx) + source[y1 * w + x1][c] * tx;
            *value = top * (1.0 - ty) + bottom * ty;
        }
    }
}

#[cfg(test)]
mod tests;

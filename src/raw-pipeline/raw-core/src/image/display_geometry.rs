//! Exact display-to-sensor geometry shared by selection and GPU presentation.
use super::ExifOrientation;

impl ExifOrientation {
    /// Display pixel-edge UV to sensor pixel-edge UV, shared by selection and present.
    pub fn display_uv_to_sensor(self, [u, v]: [f32; 2]) -> [f32; 2] {
        match self {
            Self::Normal => [u, v],
            Self::HorizontalFlip => [1.0 - u, v],
            Self::Rotate180 => [1.0 - u, 1.0 - v],
            Self::VerticalFlip => [u, 1.0 - v],
            Self::Transpose => [v, u],
            Self::Rotate90 => [v, 1.0 - u],
            Self::Transverse => [1.0 - v, 1.0 - u],
            Self::Rotate270 => [1.0 - v, u],
        }
    }

    /// Exact integer pixel-centre affine rows for the resident GPU display tail.
    pub fn display_pixel_rows(self, sw: u32, sh: u32) -> [[f32; 4]; 2] {
        let size = [sw as f32, sh as f32];
        let display = if self.swaps_wh() {
            [size[1], size[0]]
        } else {
            size
        };
        let origin = self.display_uv_to_sensor([0.0, 0.0]);
        let x = self.display_uv_to_sensor([1.0, 0.0]);
        let y = self.display_uv_to_sensor([0.0, 1.0]);
        std::array::from_fn(|i| {
            let a = ((x[i] - origin[i]) * size[i] / display[0]).round();
            let b = ((y[i] - origin[i]) * size[i] / display[1]).round();
            [a, b, origin[i] * size[i] + (a + b) * 0.5 - 0.5, 0.0]
        })
    }
}

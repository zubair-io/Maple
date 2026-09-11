//! Alpha-channel shape changes on `RasterImage` (#3505): add one, drop one, or
//! composite one away over a solid background. These are the three things
//! sharp calls `ensureAlpha`, `removeAlpha` and `flatten`.
//!
//! Alpha is STRAIGHT (not premultiplied) everywhere in `RasterImage`;
//! `raster_composite` premultiplies internally and hands back straight alpha.

use crate::raster::RasterImage;
use crate::raster_encode::composite_over_background;

impl RasterImage {
    /// Add an alpha channel filled with `alpha` when there isn't one.
    /// Already-4-channel images are returned unchanged (sharp's `ensureAlpha`
    /// only ever adds).
    pub fn ensure_alpha(&self, alpha: u8) -> Self {
        if self.channels == 4 {
            return self.clone();
        }
        let data = self
            .data
            .chunks_exact(3)
            .flat_map(|px| [px[0], px[1], px[2], alpha])
            .collect();
        Self {
            channels: 4,
            data,
            ..self.clone()
        }
    }

    /// Drop the alpha channel, keeping the colour samples as stored — no
    /// compositing. A fully transparent white pixel becomes opaque white.
    pub fn remove_alpha(&self) -> Self {
        if self.channels == 3 {
            return self.clone();
        }
        Self {
            channels: 3,
            data: self.to_rgb_bytes(),
            ..self.clone()
        }
    }

    /// Composite over an opaque `background` and drop the alpha channel.
    ///
    /// Shares its arithmetic with the JPEG/TIFF encode path via
    /// [`crate::raster_encode::composite_over_background`] (A1, #3505) so
    /// the two paths can never disagree on how a transparent pixel blends.
    pub fn flatten(&self, background: [u8; 3]) -> Self {
        composite_over_background(self, background)
    }

    /// No alpha channel, or every alpha sample is 255.
    pub fn is_opaque(&self) -> bool {
        self.channels != 4 || self.data.chunks_exact(4).all(|px| px[3] == 255)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_alpha_adds_an_opaque_channel_to_rgb() {
        let rgb = RasterImage::new_rgb(2, 1, vec![1, 2, 3, 4, 5, 6]);
        let rgba = rgb.ensure_alpha(255);
        assert_eq!(rgba.channels, 4);
        assert_eq!(rgba.data, vec![1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn ensure_alpha_leaves_an_existing_channel_alone() {
        let rgba = RasterImage::new_rgba(1, 1, vec![9, 9, 9, 17]);
        assert_eq!(rgba.ensure_alpha(255).data, vec![9, 9, 9, 17]);
    }

    #[test]
    fn ensure_alpha_honours_a_partial_value() {
        let rgb = RasterImage::new_rgb(1, 1, vec![7, 7, 7]);
        assert_eq!(rgb.ensure_alpha(128).data, vec![7, 7, 7, 128]);
    }

    #[test]
    fn remove_alpha_drops_the_channel_without_compositing() {
        // A fully transparent white pixel keeps its white RGB under
        // removeAlpha — that is what distinguishes it from flatten.
        let rgba = RasterImage::new_rgba(1, 1, vec![255, 255, 255, 0]);
        let rgb = rgba.remove_alpha();
        assert_eq!(rgb.channels, 3);
        assert_eq!(rgb.data, vec![255, 255, 255]);
    }

    #[test]
    fn flatten_composites_over_the_background() {
        // 50% red over a blue background: 200*128/255 + 0 = 100 (rounded),
        // blue channel 0*128/255 + 255*127/255 = 127.
        let rgba = RasterImage::new_rgba(1, 1, vec![200, 0, 0, 128]);
        let flat = rgba.flatten([0, 0, 255]);
        assert_eq!(flat.channels, 3);
        assert_eq!(flat.data, vec![100, 0, 127]);
    }

    #[test]
    fn flatten_on_rgb_is_a_no_op() {
        let rgb = RasterImage::new_rgb(1, 1, vec![3, 4, 5]);
        assert_eq!(rgb.flatten([255, 255, 255]).data, vec![3, 4, 5]);
    }

    #[test]
    fn is_opaque_reports_the_alpha_channel() {
        assert!(RasterImage::new_rgb(1, 1, vec![0, 0, 0]).is_opaque());
        assert!(RasterImage::new_rgba(1, 1, vec![0, 0, 0, 255]).is_opaque());
        assert!(!RasterImage::new_rgba(1, 1, vec![0, 0, 0, 254]).is_opaque());
    }
}

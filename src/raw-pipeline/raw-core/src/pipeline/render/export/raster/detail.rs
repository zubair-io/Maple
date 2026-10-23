//! Immutable oriented raster source for native detail windows (#4317).
use super::*;
use crate::pipeline::{apply_scene_linear_chain_f32_windowed_cancellable, ChainWindow, TileRect};
use crate::stages::dehaze::FrameHaze;

pub struct RasterDetailImage {
    width: u32,
    height: u32,
    rgba: Vec<f32>,
    /// The frame's dehaze maps for the last model that needed them (#3287),
    /// keyed by [`crate::stages::dehaze::haze_key`].
    haze: std::sync::Mutex<Option<(AdjustmentModel, std::sync::Arc<FrameHaze>)>>,
}

impl RasterDetailImage {
    pub fn open(bytes: &[u8], cancel: crate::CancelToken<'_>) -> Result<Self> {
        let (width, height, rgba) = decode_raster_base(bytes, u32::MAX, cancel)?;
        Ok(Self {
            width,
            height,
            rgba,
            haze: std::sync::Mutex::new(None),
        })
    }

    /// The whole source's haze maps for `model`, measured once and reused
    /// while only dehaze amounts the maps do not depend on change.
    fn frame_haze(
        &self,
        model: &AdjustmentModel,
        options: &ChainOptions<'_>,
        cancel: crate::CancelToken<'_>,
    ) -> Result<Option<std::sync::Arc<FrameHaze>>> {
        if !crate::stages::dehaze::any_engaged(model) {
            return Ok(None);
        }
        let key = crate::stages::dehaze::haze_key(model);
        let mut slot = self
            .haze
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((_, haze)) = slot.as_ref().filter(|(cached, _)| *cached == key) {
            return Ok(Some(haze.clone()));
        }
        let haze = crate::pipeline::scene_linear_chain_haze_map_cancellable(
            &self.rgba,
            self.width,
            self.height,
            model,
            options,
            cancel,
        )?
        .map(std::sync::Arc::new);
        *slot = haze.clone().map(|haze| (key, haze));
        Ok(haze)
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn render_tile(
        &self,
        model: &AdjustmentModel,
        rect: TileRect,
        film: Option<&FilmLut>,
        max_working_pixels: u64,
        cancel: crate::CancelToken<'_>,
    ) -> Result<(u32, u32, Vec<u8>)> {
        self.render_tile_with_target(
            model,
            rect,
            film,
            max_working_pixels,
            TargetPrimaries::Srgb,
            cancel,
        )
    }

    pub fn render_tile_with_target(
        &self,
        model: &AdjustmentModel,
        rect: TileRect,
        film: Option<&FilmLut>,
        max_working_pixels: u64,
        target: TargetPrimaries,
        cancel: crate::CancelToken<'_>,
    ) -> Result<(u32, u32, Vec<u8>)> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        validate_raster_adjustments(model)?;
        if !model.film_look.is_empty() && film.is_none() {
            return Err(unsupported("selected film LUT is unavailable"));
        }
        if !crate::stages::perspective::Perspective::from_model(model).is_identity() {
            return Err(unsupported(
                "native detail requires no perspective corrections",
            ));
        }
        if u64::from(rect.src_w) * u64::from(rect.src_h) > max_working_pixels {
            return Err(unsupported(
                "native detail output exceeds the memory budget",
            ));
        }
        if rect.src_w != rect.out_w || rect.src_h != rect.out_h {
            return Err(unsupported(
                "native detail requires native output dimensions",
            ));
        }
        let mapped = crate::stages::crop::CropDetailWindow::new(
            &model.crop,
            self.width,
            self.height,
            (rect.src_x, rect.src_y, rect.src_w, rect.src_h),
        )
        .ok_or_else(|| unsupported("invalid or resampled native-detail crop rectangle"))?;
        let (sx, sy, sw, sh) = mapped.source();
        let rect = TileRect {
            src_x: sx,
            src_y: sy,
            src_w: sw,
            src_h: sh,
            out_w: sw,
            out_h: sh,
        };
        let halo = crate::pipeline::tile::raster_window_overlap(model, self.width.max(self.height));
        let x = rect.src_x.saturating_sub(halo);
        let y = rect.src_y.saturating_sub(halo);
        let right = rect
            .src_x
            .saturating_add(rect.src_w)
            .saturating_add(halo)
            .min(self.width);
        let bottom = rect
            .src_y
            .saturating_add(rect.src_h)
            .saturating_add(halo)
            .min(self.height);
        let (w, h) = (right - x, bottom - y);
        if u64::from(w) * u64::from(h) > max_working_pixels {
            return Err(unsupported("native detail patch exceeds the memory budget"));
        }
        let input: Vec<f32> = (y..bottom)
            .flat_map(|row| {
                let start = (row as usize * self.width as usize + x as usize) * 4;
                self.rgba[start..start + w as usize * 4].iter().copied()
            })
            .collect();
        let options = ChainOptions {
            skip_agx: true,
            ..Default::default()
        };
        let haze = self.frame_haze(model, &options, cancel)?;
        let output = apply_scene_linear_chain_f32_windowed_cancellable(
            &input,
            w,
            h,
            model,
            &ChainOptions {
                haze_map: haze.as_deref(),
                ..options
            },
            film,
            ChainWindow {
                x,
                y,
                full_width: self.width,
                full_height: self.height,
            },
            cancel,
        )?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let mut image = Image {
            width: w,
            height: h,
            pixels: output.chunks_exact(4).map(|p| [p[0], p[1], p[2]]).collect(),
            space: ColorSpace::DisplayLinearRec2020,
            nr_sampling_scale: 1.0,
            whites_anchor_ev: None,
        };
        encode::rec2020_to_display(&mut image, target);
        encode::srgb_gamma_encode(&mut image);
        let rgb = encode::dither_and_quantize_windowed(&mut image, (x, y));
        let result: Vec<u8> = (rect.src_y - y..rect.src_y - y + rect.src_h)
            .flat_map(|row| {
                let start = (row as usize * w as usize + (rect.src_x - x) as usize) * 3;
                rgb[start..start + rect.src_w as usize * 3].iter().copied()
            })
            .collect();
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        mapped.apply_rgb(result, cancel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};

    #[test]
    fn native_raster_window_matches_each_requested_display_target() {
        let (w, h) = (96, 80);
        let rgb: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % w * 2) as u8, (i / w * 3) as u8, 160])
            .collect();
        let mut bytes = Vec::new();
        PngEncoder::new(&mut bytes)
            .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
            .unwrap();
        let source = RasterDetailImage::open(&bytes, crate::CancelToken::never()).unwrap();
        let model = AdjustmentModel {
            exposure: 0.3,
            grain_amount: 25.0,
            sharpen_amount: 0.0,
            nr_color: 0.0,
            ..Default::default()
        };
        let rect = TileRect {
            src_x: 16,
            src_y: 12,
            src_w: 32,
            src_h: 24,
            out_w: 32,
            out_h: 24,
        };
        let mut previous = None;
        for target in [TargetPrimaries::Srgb, TargetPrimaries::P3] {
            let (_, _, pixels) = super::super::render_export_raster(
                &bytes,
                &model,
                None,
                target,
                ExportDepth::Eight,
                None,
            )
            .unwrap();
            let ExportPixels::Eight(full) = pixels else {
                panic!("expected eight-bit reference");
            };
            let (_, _, patch) = source
                .render_tile_with_target(
                    &model,
                    rect,
                    None,
                    1024 * 1024,
                    target,
                    crate::CancelToken::never(),
                )
                .unwrap();
            for y in 0..rect.src_h {
                for x in 0..rect.src_w {
                    for c in 0..3 {
                        let actual = patch[((y * rect.src_w + x) * 3 + c) as usize];
                        let expected =
                            full[(((y + rect.src_y) * w + x + rect.src_x) * 3 + c) as usize];
                        assert!(
                            actual.abs_diff(expected) <= 1,
                            "target {target:?} at ({x},{y})"
                        );
                    }
                }
            }
            if let Some(previous) = previous.take() {
                assert_ne!(previous, patch);
            }
            previous = Some(patch);
        }
    }
}

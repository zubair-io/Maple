//! Immutable oriented raster source for native detail windows (#4317).
use super::*;
use crate::pipeline::{apply_scene_linear_chain_f32_windowed_cancellable, ChainWindow, TileRect};

pub struct RasterDetailImage {
    width: u32,
    height: u32,
    rgba: Vec<f32>,
}

impl RasterDetailImage {
    pub fn open(bytes: &[u8], cancel: crate::CancelToken<'_>) -> Result<Self> {
        let (width, height, rgba) = decode_raster_base(bytes, u32::MAX, cancel)?;
        Ok(Self {
            width,
            height,
            rgba,
        })
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
        let output = apply_scene_linear_chain_f32_windowed_cancellable(
            &input,
            w,
            h,
            model,
            &ChainOptions {
                skip_agx: true,
                ..Default::default()
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
        encode::rec2020_to_display(&mut image, TargetPrimaries::Srgb);
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

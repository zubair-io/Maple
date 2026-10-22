//! CPU-only native detail custody. The GPU worker lends immutable source Arcs;
//! the shared core owns crop/orientation, Auto anchors, colour and memory admission.
use crate::{guarded, text, Session};
use raw_core::{
    pipeline::{
        self, DetailContext, DetailRenderOptions, RasterDetailImage, RawInput, RenderQuality,
        TileRect,
    },
    view::encode::TargetPrimaries,
    AdjustmentModel, RawImage,
};
use std::{
    ffi::{c_char, c_void},
    path::Path,
    ptr,
    sync::{Arc, Mutex},
};

const MAX_WORKING_PIXELS: u64 = 8 * 1024 * 1024;
const MAX_RASTER_PIXELS: u64 = 32 * 1024 * 1024;

pub struct DetailSource {
    raw: Option<Arc<RawImage>>,
    bytes: Arc<Vec<u8>>,
    ext: String,
    raster: Option<RasterDetailImage>,
    prepared: Option<Prepared>,
}
struct Prepared {
    model: AdjustmentModel,
    target: TargetPrimaries,
    context: DetailContext,
}
pub type SharedDetail = Arc<Mutex<DetailSource>>;

impl DetailSource {
    pub fn new(raw: Option<Arc<RawImage>>, bytes: Arc<Vec<u8>>, ext: String) -> SharedDetail {
        Arc::new(Mutex::new(Self {
            raw,
            bytes,
            ext,
            raster: None,
            prepared: None,
        }))
    }
    fn open(path: &str) -> Result<SharedDetail, String> {
        let bytes = Arc::new(std::fs::read(path).map_err(|e| e.to_string())?);
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let raw = if crate::preview::is_raw(&ext) {
            Some(
                raw_core::decode_cache::decode_bytes_cached(
                    &raw_core::decode_cache::CacheKey::from_bytes(&bytes),
                    &bytes,
                    &ext,
                )
                .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        Ok(Self::new(raw, bytes, ext))
    }
    fn render(
        &mut self,
        xml: &str,
        rect: TileRect,
        target: TargetPrimaries,
        cancel: raw_core::CancelToken<'_>,
    ) -> Result<(u32, u32, Vec<u8>), String> {
        if cancel.is_cancelled() {
            return Err("Native detail cancelled".into());
        }
        let model = crate::xmp::parse(xml)?;
        let film = crate::film::resolve(&model.film_look)?;
        if !model.film_look.is_empty() && film.is_none() {
            return Err("Selected film look is unavailable".into());
        }
        if let Some(raw) = &self.raw {
            if self
                .prepared
                .as_ref()
                .is_none_or(|p| p.model != model || p.target != target)
            {
                let previous = self.prepared.take().map(|p| p.context);
                let (_, _, _, context) = pipeline::render_detail_base_retained_cancellable(
                    Arc::clone(raw),
                    &model,
                    RawInput::Bytes {
                        bytes: &self.bytes,
                        ext: &self.ext,
                    },
                    DetailRenderOptions {
                        target,
                        quality: RenderQuality::Amaze,
                        max_long_edge: 2048,
                        film_lut: film.map(|f| f.0),
                    },
                    MAX_WORKING_PIXELS,
                    previous,
                    cancel,
                )
                .map_err(|e| e.to_string())?;
                self.prepared = Some(Prepared {
                    model,
                    target,
                    context,
                });
            }
            let context = &self
                .prepared
                .as_ref()
                .ok_or("Missing detail context")?
                .context;
            return pipeline::render_detail_tile_cancellable(
                raw,
                context,
                rect,
                film.map(|f| f.0),
                MAX_WORKING_PIXELS,
                cancel,
            )
            .map_err(|e| e.to_string());
        }
        if self.raster.is_none() {
            let meta = raw_core::raster::probe_raster_metadata_reader(&mut std::io::Cursor::new(
                &*self.bytes,
            ))
            .map_err(|e| e.to_string())?;
            if u64::from(meta.width) * u64::from(meta.height) > MAX_RASTER_PIXELS {
                return Err("Image exceeds the native-detail raster memory budget".into());
            }
            self.raster =
                Some(RasterDetailImage::open(&self.bytes, cancel).map_err(|e| e.to_string())?);
        }
        self.raster
            .as_ref()
            .ok_or("Missing raster source")?
            .render_tile_with_target(
                &model,
                rect,
                film.map(|f| f.0),
                MAX_WORKING_PIXELS,
                target,
                cancel,
            )
            .map_err(|e| e.to_string())
    }
}

#[repr(C)]
pub struct PatchView {
    pub width: u32,
    pub height: u32,
    pub target: u32,
    pub pixels: *const u8,
}
#[repr(C)]
struct Patch {
    view: PatchView,
    pixels: Vec<u8>,
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_detail_open(path: *const c_char) -> *mut c_void {
    guarded(ptr::null_mut(), || {
        Ok(Box::into_raw(Box::new(DetailSource::open(text(path)?)?)).cast())
    })
}
#[no_mangle]
pub unsafe extern "C" fn maple_android_detail_from_session(handle: *const c_void) -> *mut c_void {
    guarded(ptr::null_mut(), || {
        let session = handle.cast::<Session>().as_ref().ok_or("Closed editor")?;
        Ok(Box::into_raw(Box::new(session.detail_source())).cast())
    })
}
#[no_mangle]
pub unsafe extern "C" fn maple_android_detail_free(handle: *mut c_void) {
    if !handle.is_null() {
        drop(Box::from_raw(handle.cast::<SharedDetail>()));
    }
}
#[no_mangle]
pub unsafe extern "C" fn maple_android_detail_render(
    handle: *const c_void,
    xml: *const c_char,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    target: u32,
    flag: *const c_void,
) -> *mut PatchView {
    guarded(ptr::null_mut(), || {
        let source = handle
            .cast::<SharedDetail>()
            .as_ref()
            .ok_or("Closed detail source")?;
        let cancel = crate::cancellation::token(flag)?;
        let target_space = match target {
            0 => TargetPrimaries::Srgb,
            1 => TargetPrimaries::P3,
            _ => return Err("Unsupported display target".into()),
        };
        let rect = TileRect {
            src_x: x,
            src_y: y,
            src_w: width,
            src_h: height,
            out_w: width,
            out_h: height,
        };
        let (width, height, pixels) = source.lock().map_err(|_| "Detail source failed")?.render(
            text(xml)?,
            rect,
            target_space,
            raw_core::CancelToken::new(cancel.flag()),
        )?;
        let view = PatchView {
            width,
            height,
            target,
            pixels: pixels.as_ptr(),
        };
        Ok(Box::into_raw(Box::new(Patch { view, pixels })).cast())
    })
}
#[no_mangle]
pub unsafe extern "C" fn maple_android_detail_patch_free(patch: *mut PatchView) {
    if !patch.is_null() {
        drop(Box::from_raw(patch.cast::<Patch>()));
    }
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_native_dimensions(
    path: *const c_char,
    extension: *const c_char,
) -> u64 {
    guarded(0, || {
        let path = Path::new(text(path)?);
        let [width, height] = if crate::preview::is_raw(&text(extension)?.to_ascii_lowercase()) {
            raw_core::raw_dimensions::from_file(path).map_err(|e| e.to_string())?
        } else {
            let mut file =
                std::io::BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
            let metadata = raw_core::raster::probe_raster_metadata_reader(&mut file)
                .map_err(|e| e.to_string())?;
            let orientation =
                raw_core::ExifOrientation::from_u16(metadata.orientation.unwrap_or(1));
            if orientation.swaps_wh() {
                [metadata.height, metadata.width]
            } else {
                [metadata.width, metadata.height]
            }
        };
        if width == 0 || height == 0 {
            return Err("Original dimensions are unavailable".into());
        }
        Ok((u64::from(width) << 32) | u64::from(height))
    })
}
#[no_mangle]
pub extern "C" fn maple_android_presentation_dimensions(
    width: u32,
    height: u32,
    top: f32,
    left: f32,
    bottom: f32,
    right: f32,
    angle: f32,
) -> u64 {
    let crop = raw_core::types::Crop {
        top,
        left,
        bottom,
        right,
        angle,
    };
    let dims = raw_core::stages::crop::CropPresentation::new(&crop, width, height).dims;
    (u64::from(dims.0) << 32) | u64::from(dims.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detail_source_can_cross_threads_without_gpu_custody() {
        fn check<T: Send + Sync>() {}
        check::<SharedDetail>();
    }
}

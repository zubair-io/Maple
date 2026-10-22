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
const MAX_RASTER_DECODE_BYTES: u64 = 320 * 1024 * 1024;
// decode_raster_base simultaneously owns RGB f32 plus input/output RGBA f32.
const RASTER_DECODE_BYTES_PER_PIXEL: u64 = (3 + 4 + 4) * std::mem::size_of::<f32>() as u64;

fn raster_decode_fits(width: u32, height: u32, encoded_bytes: usize) -> bool {
    width != 0
        && height != 0
        && u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(RASTER_DECODE_BYTES_PER_PIXEL))
            .and_then(|bytes| bytes.checked_add(encoded_bytes as u64))
            .is_some_and(|bytes| bytes <= MAX_RASTER_DECODE_BYTES)
}

// RGB32F staging writes 12 bytes/pixel; reserve 64 KiB for TIFF tags and
// the fixed matrix/TRC ICC profile before the platform decoder allocates pixels.
#[no_mangle]
pub extern "C" fn maple_android_platform_detail_fits(width: u32, height: u32) -> u8 {
    let encoded = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(12))
        .and_then(|bytes| bytes.checked_add(64 * 1024))
        .and_then(|bytes| usize::try_from(bytes).ok());
    u8::from(encoded.is_some_and(|bytes| raster_decode_fits(width, height, bytes)))
}

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
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !crate::preview::is_raw(&ext) {
            let mut file =
                std::io::BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
            let length =
                usize::try_from(file.get_ref().metadata().map_err(|e| e.to_string())?.len())
                    .map_err(|_| "Native detail raster exceeds the decode memory budget")?;
            let meta = raw_core::raster::probe_raster_metadata_reader(&mut file)
                .map_err(|e| e.to_string())?;
            if !raster_decode_fits(meta.width, meta.height, length) {
                return Err("Native detail raster exceeds the decode memory budget".into());
            }
        }
        let bytes = Arc::new(std::fs::read(path).map_err(|e| e.to_string())?);
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
            if !raster_decode_fits(meta.width, meta.height, self.bytes.len()) {
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
    fn raster_decode_admission_counts_all_float_buffers_and_encoded_bytes() {
        assert_eq!(RASTER_DECODE_BYTES_PER_PIXEL, 44);
        assert!(raster_decode_fits(1920, 1080, 2 * 1024 * 1024));
        assert!(raster_decode_fits(3072, 2048, 8 * 1024 * 1024));
        assert!(!raster_decode_fits(4000, 3000, 1024));
        assert!(!raster_decode_fits(8000, 4000, 1024));
        let pixels = (MAX_RASTER_DECODE_BYTES / RASTER_DECODE_BYTES_PER_PIXEL) as u32;
        let remaining =
            (MAX_RASTER_DECODE_BYTES - u64::from(pixels) * RASTER_DECODE_BYTES_PER_PIXEL) as usize;
        assert!(raster_decode_fits(pixels, 1, remaining));
        assert!(!raster_decode_fits(pixels, 1, remaining + 1));
    }

    #[test]
    fn platform_admission_includes_the_uncompressed_tiff_before_staging() {
        assert_eq!(maple_android_platform_detail_fits(1920, 1080), 1);
        assert_eq!(maple_android_platform_detail_fits(3072, 2048), 0);
        assert_eq!(maple_android_platform_detail_fits(4000, 3000), 0);
        assert_eq!(maple_android_platform_detail_fits(8000, 6000), 0);
        assert_eq!(maple_android_platform_detail_fits(u32::MAX, u32::MAX), 0);
        assert_eq!(maple_android_platform_detail_fits(0, 1080), 0);
    }

    #[test]
    fn raster_decode_admission_rejects_overflow_and_empty_dimensions() {
        assert!(!raster_decode_fits(u32::MAX, u32::MAX, 0));
        assert!(!raster_decode_fits(1, 1, usize::MAX));
        assert!(!raster_decode_fits(0, 1080, 0));
    }

    #[test]
    fn oversized_raster_is_rejected_from_its_header_before_pixel_decode() {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut bytes)
            .encode(&[100, 100, 100], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        let marker = bytes.windows(2).position(|p| p == [0xff, 0xc0]).unwrap();
        bytes[marker + 5..marker + 7].copy_from_slice(&3000u16.to_be_bytes());
        bytes[marker + 7..marker + 9].copy_from_slice(&4000u16.to_be_bytes());
        let path =
            std::env::temp_dir().join(format!("maple-detail-admission-{}.jpg", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let opened = DetailSource::open(path.to_str().unwrap());
        std::fs::remove_file(path).unwrap();
        assert!(opened.err().unwrap().contains("decode memory budget"));
        let source = DetailSource::new(None, Arc::new(bytes), "jpg".into());
        let mut source = source.lock().unwrap();
        let result = source.render(r#"<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description/></r:RDF>"#, TileRect {
            src_x: 0, src_y: 0, src_w: 32, src_h: 32, out_w: 32, out_h: 32,
        }, TargetPrimaries::Srgb, raw_core::CancelToken::never());
        assert!(result.unwrap_err().contains("raster memory budget"));
        assert!(source.raster.is_none());
    }

    #[test]
    fn detail_source_can_cross_threads_without_gpu_custody() {
        fn check<T: Send + Sync>() {}
        check::<SharedDetail>();
    }
}

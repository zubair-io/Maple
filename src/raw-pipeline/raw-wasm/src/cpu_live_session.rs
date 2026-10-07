//! CPU fallback retains the source and viewport prefix instead of rereading
//! the RAW on every global detail edit (#4352/#4112).
use crate::render::MapleRender;
use raw_core::{
    image::RawImage,
    pipeline::{CpuPreview, RawInput, RenderQuality},
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct CpuLiveSession {
    bytes: Vec<u8>,
    ext: String,
    raw: RawImage,
    preview: Option<CpuPreview>,
    lens_generation: u64,
    film_bytes: Vec<u8>,
    film: Option<raw_core::film::FilmLut>,
    as_shot: (f32, f32),
    support: Option<raw_core::support_tiers::RenderSupport>,
}
#[wasm_bindgen]
impl CpuLiveSession {
    pub fn open(bytes: Vec<u8>, ext: &str) -> Result<Self, JsError> {
        let raw = raw_core::decode::decode_bytes(&bytes, ext)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let (as_shot, support) = crate::open_metadata::assess(&raw);
        Ok(Self {
            bytes,
            ext: ext.to_owned(),
            raw,
            preview: None,
            lens_generation: crate::lens_profile::registry_generation(),
            film_bytes: Vec::new(),
            film: None,
            as_shot,
            support,
        })
    }
    pub fn render(
        &mut self,
        xmp: Option<String>,
        quality_preview: bool,
        max_long_edge: u32,
        film_bytes: &[u8],
    ) -> Result<MapleRender, JsError> {
        if max_long_edge == 0 {
            return Err(JsError::new("CPU viewport cap must be positive"));
        }
        let model = crate::mask_registry::parse_model(xmp.as_deref())
            .map_err(|e| JsError::new(&e.to_string()))?;
        if film_bytes != self.film_bytes {
            let decoded = if film_bytes.is_empty() {
                None
            } else {
                Some(
                    raw_core::film::decode_mlut(film_bytes)
                        .map_err(|e| JsError::new(&e.to_string()))?,
                )
            };
            self.film = decoded;
            self.film_bytes.clear();
            self.film_bytes.extend_from_slice(film_bytes);
        }
        let lens_generation = crate::lens_profile::registry_generation();
        if lens_generation != self.lens_generation {
            self.preview = None;
            self.lens_generation = lens_generation;
        }
        let quality = if quality_preview {
            RenderQuality::Preview
        } else {
            RenderQuality::Amaze
        };
        let cap = crate::cpu_budget::clamp_develop_long_edge(
            self.raw.width,
            self.raw.height,
            Some(max_long_edge),
        )
        .unwrap_or(max_long_edge);
        let source = RawInput::Bytes {
            bytes: &self.bytes,
            ext: &self.ext,
        };
        // Metadata is read before moving the model into the retained core.
        let lens = crate::lens_profile::metadata(&self.raw, &model);
        let (temperature, tint) = self.as_shot;
        let (w, h, rgb, fit) = if !quality_preview {
            // Refine keeps its canonical quality/density and cannot evict the
            // warm fast-phase prefix. The decoded original remains resident.
            raw_core::pipeline::render_from_raw_with_auto_fit(
                &self.raw,
                &model,
                quality,
                Some(source),
                Some(cap),
                self.film.as_ref(),
            )
            .map_err(|e| JsError::new(&e.to_string()))?
        } else if let Some(preview) = &mut self.preview {
            preview
                .render(
                    &self.raw,
                    source,
                    model,
                    quality,
                    cap,
                    self.film.as_ref(),
                    raw_core::cancel::CancelToken::never(),
                )
                .map_err(|e| JsError::new(&e.to_string()))?
        } else {
            let (preview, w, h, rgb, fit) =
                CpuPreview::open(&self.raw, source, model, quality, cap, self.film.as_ref())
                    .map_err(|e| JsError::new(&e.to_string()))?;
            self.preview = Some(preview);
            (w, h, rgb, fit)
        };
        let (full_w, full_h) = raw_core::pipeline::native_render_dims(&self.raw);
        Ok(MapleRender::new(
            w,
            h,
            full_w,
            full_h,
            rgb,
            temperature,
            tint,
            self.raw.has_lens_corrections(),
            self.raw.lens_correction_ca_inert(),
            self.support.clone(),
            lens,
            fit,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refine_preserves_fast_session_and_matches_legacy_bytes() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
        let bytes = std::fs::read(path).expect("committed DNG");
        let mut session = CpuLiveSession::open(bytes.clone(), "dng").unwrap();
        let raw_pointer = session.raw.raw_data.as_ptr();
        let source_pointer = session.bytes.as_ptr();
        let fast = session.render(None, true, 80, &[]).unwrap();
        let preview_address = session.preview.as_ref().unwrap() as *const CpuPreview;
        let refined = session.render(None, false, 96, &[]).unwrap();
        assert_eq!(
            preview_address,
            session.preview.as_ref().unwrap() as *const CpuPreview
        );
        let again = session.render(None, true, 80, &[]).unwrap();
        assert_eq!(fast.rgb(), again.rgb());
        assert_eq!(raw_pointer, session.raw.raw_data.as_ptr());
        assert_eq!(source_pointer, session.bytes.as_ptr());
        for (actual, quality, cap) in [(fast, true, 80), (refined, false, 96)] {
            let expected =
                crate::render::render_bytes_sized(&bytes, "dng", None, quality, cap).unwrap();
            assert_eq!(
                (actual.width(), actual.height(), actual.rgb()),
                (expected.width(), expected.height(), expected.rgb())
            );
            assert_eq!(actual.camera_support_json(), expected.camera_support_json());
            assert_eq!(actual.as_shot_temperature(), expected.as_shot_temperature());
            assert_eq!(actual.as_shot_tint(), expected.as_shot_tint());
        }
    }

    #[test]
    fn lens_registry_change_rebuilds_retained_prefix() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
        let bytes = std::fs::read(path).expect("committed DNG");
        let mut session = CpuLiveSession::open(bytes, "dng").unwrap();
        let before = session.render(None, true, 80, &[]).unwrap();
        crate::lens_profile::clear_lens_profiles().unwrap();
        assert_ne!(
            session.lens_generation,
            crate::lens_profile::registry_generation()
        );
        let after = session.render(None, true, 80, &[]).unwrap();
        assert_eq!(
            session.lens_generation,
            crate::lens_profile::registry_generation()
        );
        assert_eq!(before.rgb(), after.rgb());
    }
}

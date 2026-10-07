//! Relocatable shared film assets, decoded once outside hot ticks (#4317).
use raw_core::film::{decode_mlut, FilmLut};
use raw_core::types::adjustment::AdjustmentModel;
use std::{borrow::Cow, sync::OnceLock};

include!(concat!(env!("OUT_DIR"), "/film_resources.rs"));
static DECODED: [OnceLock<Result<FilmLut, String>>; BUNDLED.len()] =
    [const { OnceLock::new() }; BUNDLED.len()];

pub struct ResolvedFilm {
    pub lut: &'static FilmLut,
    /// Unique within this immutable embedded pack; zero means no film.
    pub key: u32,
}

pub fn resolve(id: &str) -> Result<Option<ResolvedFilm>, String> {
    if id.is_empty() {
        return Ok(None);
    }
    // An id from a newer catalog renders as identity and is kept verbatim on
    // save (docs/xmp-canonical-format.md), matching the other shells.
    let Some(index) = BUNDLED.iter().position(|(known, _)| *known == id) else {
        return Ok(None);
    };
    let lut = DECODED[index]
        .get_or_init(|| {
            let lut = decode_mlut(BUNDLED[index].1).map_err(|e| e.to_string())?;
            if lut.data.iter().any(|value| !value.is_finite()) {
                return Err("Film resource contains non-finite values".into());
            }
            Ok(lut)
        })
        .as_ref()
        .map_err(Clone::clone)?;
    Ok(Some(ResolvedFilm {
        lut,
        key: index as u32 + 1,
    }))
}

/// The model a render should use with its film: an id from a newer catalog
/// renders without film, while the sidecar keeps the id verbatim.
pub fn renderable(
    model: &AdjustmentModel,
) -> Result<(Cow<'_, AdjustmentModel>, Option<ResolvedFilm>), String> {
    let film = resolve(&model.film_look)?;
    let model = if film.is_none() && !model.film_look.is_empty() {
        Cow::Owned(AdjustmentModel {
            film_look: String::new(),
            ..model.clone()
        })
    } else {
        Cow::Borrowed(model)
    };
    Ok((model, film))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_catalog_is_embedded_valid_and_reuses_decoded_storage() {
        assert_eq!(BUNDLED.len(), raw_core::film_catalog::FILM_CATALOG.len());
        for entry in raw_core::film_catalog::FILM_CATALOG {
            let first = resolve(entry.id).unwrap().unwrap();
            let again = resolve(entry.id).unwrap().unwrap();
            assert!(std::ptr::eq(first.lut, again.lut));
            assert_eq!(first.key, again.key);
            assert!(first.key > 0);
            assert_eq!(first.lut.data.len(), first.lut.size.pow(3) * 3);
        }
        assert!(resolve("").unwrap().is_none());
        assert!(resolve("../../arbitrary-file").unwrap().is_none());
    }
}

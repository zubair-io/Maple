use raw_core::film::{decode_mlut, FilmLut};
use std::sync::OnceLock;
include!(concat!(env!("OUT_DIR"), "/films.rs"));
static DECODED: [OnceLock<Result<FilmLut, String>>; FILMS.len()] =
    [const { OnceLock::new() }; FILMS.len()];

pub fn resolve(id: &str) -> Result<Option<(&'static FilmLut, u32)>, String> {
    let Some(index) = FILMS.iter().position(|(key, _)| *key == id) else {
        return Ok(None);
    };
    let result =
        DECODED[index].get_or_init(|| decode_mlut(FILMS[index].1).map_err(|e| e.to_string()));
    result
        .as_ref()
        .map(|lut| Some((lut, index as u32 + 1)))
        .map_err(Clone::clone)
}

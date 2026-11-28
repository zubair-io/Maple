//! One grid tile: the shared thumbnail when fresh, else the camera's preview for an unedited RAW or a develop, published.
use eframe::egui;
use image::{DynamicImage, RgbImage};

use super::{disk, embedded};
use crate::library::{MediaKind, Photo};

const DISPLAY_EDGE_PX: u32 = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Source {
    Cache,
    CameraPreview,
    Developed,
}

pub(super) type Develop<'a> = &'a dyn Fn(&Photo, u32) -> Result<RgbImage, String>;
pub(super) type Extract<'a> = &'a dyn Fn(&Photo, u32) -> Option<RgbImage>;

pub(super) fn produce(
    photo: &Photo,
    develop: Develop,
    camera_preview: Extract,
    encode: disk::Encode,
) -> Result<(RgbImage, Source), String> {
    let inputs = disk::Inputs::of(&photo.path);
    if let Some(cached) = disk::read_fresh(&photo.path, inputs) {
        return Ok((cached, Source::Cache));
    }
    let unedited_raw = photo.kind == MediaKind::Raw
        && !embedded::is_edited(photo).map_err(|error| error.to_string())?;
    let (image, source) = match unedited_raw
        .then(|| camera_preview(photo, disk::LONG_EDGE_PX))
        .flatten()
    {
        Some(preview) => (preview, Source::CameraPreview),
        None => (develop(photo, disk::LONG_EDGE_PX)?, Source::Developed),
    };
    disk::write(&photo.path, inputs, &image, encode);
    Ok((image, source))
}

pub(super) fn display(image: RgbImage) -> egui::ColorImage {
    let shown =
        raw_core::preview::resize_long_edge(DynamicImage::ImageRgb8(image), DISPLAY_EDGE_PX)
            .to_rgb8();
    egui::ColorImage::from_rgb(
        [shown.width() as usize, shown.height() as usize],
        shown.as_raw(),
    )
}

pub(super) fn render(photo: &Photo) -> Result<egui::ColorImage, String> {
    produce(photo, &develop, &embedded::camera_preview, &disk::encode)
        .map(|(image, _)| display(image))
}

fn develop(photo: &Photo, long_edge: u32) -> Result<RgbImage, String> {
    let (session, document) = super::super::Session::open(0, photo.clone())?;
    let (width, height, rgb, _) = session.render_rgb(&document.model, long_edge)?;
    RgbImage::from_raw(width, height, rgb).ok_or_else(|| "The rendered tile is malformed".into())
}

#[cfg(test)]
#[path = "tile_tests.rs"]
mod tile_tests;

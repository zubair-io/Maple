//! Shared integer display tail for the live sensor-framed upload (#3982).
use raw_core::{
    image::ExifOrientation,
    stages::{crop::CropPresentation, perspective},
    xmp::AdjustmentModel,
};
use raw_gpu::{PresentGeometry, QuantizedDisplayTail};

pub(crate) fn display_geometry(
    orientation: ExifOrientation,
    source: (u32, u32),
    model: &AdjustmentModel,
) -> PresentGeometry {
    let (w, h) = if orientation.swaps_wh() {
        (source.1, source.0)
    } else {
        source
    };
    let perspective = perspective::Perspective::from_model(model);
    let geometry = if perspective.is_identity() {
        PresentGeometry::IDENTITY
    } else {
        PresentGeometry::from_inverse(
            perspective
                .inverse_matrix(perspective::aspect_ratio(w, h))
                .0,
        )
    };
    let crop = CropPresentation::new(&model.crop, w, h);
    geometry.with_quantized_tail(QuantizedDisplayTail {
        orientation_rows: orientation.display_pixel_rows(source.0, source.1),
        crop_rows: crop.rows,
        crop_rotation: crop.rotation,
        dimensions: [w, h, 1, u32::from(crop.bilinear)],
        output_size: crop.output_size,
    })
}

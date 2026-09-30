use super::{MapleRawHandle, MapleRawHandleInner};
use crate::error::set_last_error;
use raw_core::image::{CropRect, ExifOrientation};

/// Native-detail coordinates (#3876): oriented sensor extent and the default
/// crop within it. Tile requests add crop_x/y to crop-relative source pixels.
#[repr(C)]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct MapleRawGeometry {
    pub sensor_width: u32,
    pub sensor_height: u32,
    pub crop_x: u32,
    pub crop_y: u32,
    pub crop_width: u32,
    pub crop_height: u32,
}

#[no_mangle]
pub unsafe extern "C" fn maple_raw_handle_geometry(
    handle: *const MapleRawHandle,
    out: *mut MapleRawGeometry,
) -> i32 {
    if out.is_null() {
        set_last_error("null geometry output".into());
        return 1;
    }
    *out = MapleRawGeometry::default();
    if handle.is_null() || (*handle).inner.is_null() {
        set_last_error("null RAW handle".into());
        return 1;
    }
    let raw = &(*((*handle).inner as *const MapleRawHandleInner)).raw;
    *out = oriented_geometry(raw.width, raw.height, raw.crop_rect, raw.orientation);
    0
}

fn oriented_geometry(
    width: u32,
    height: u32,
    crop: Option<CropRect>,
    orientation: ExifOrientation,
) -> MapleRawGeometry {
    let (x, y, w, h) = crop
        .map(|c| {
            (
                c.x,
                c.y,
                c.w.min(width.saturating_sub(c.x)),
                c.h.min(height.saturating_sub(c.y)),
            )
        })
        .filter(|(_, _, w, h)| *w > 0 && *h > 0)
        .unwrap_or((0, 0, width, height));
    let (sensor_width, sensor_height) = if orientation.swaps_wh() {
        (height, width)
    } else {
        (width, height)
    };
    let inverse = match orientation {
        ExifOrientation::Rotate90 => ExifOrientation::Rotate270,
        ExifOrientation::Rotate270 => ExifOrientation::Rotate90,
        other => other,
    };
    let (crop_x, crop_y, crop_width, crop_height) =
        inverse.display_rect_to_sensor(x, y, w, h, sensor_width, sensor_height);
    MapleRawGeometry {
        sensor_width,
        sensor_height,
        crop_x,
        crop_y,
        crop_width,
        crop_height,
    }
}

/// EXIF orientation of the same retained decode used by repair evaluation.
/// Zero means an invalid handle; valid values are the TIFF codes 1 through 8.
#[no_mangle]
pub unsafe extern "C" fn maple_raw_handle_orientation(handle: *const MapleRawHandle) -> u32 {
    if handle.is_null() || (*handle).inner.is_null() {
        set_last_error("null RAW handle".into());
        return 0;
    }
    let raw = &(*((*handle).inner as *const MapleRawHandleInner)).raw;
    orientation_code(raw.orientation)
}

fn orientation_code(orientation: ExifOrientation) -> u32 {
    match orientation {
        ExifOrientation::Normal => 1,
        ExifOrientation::HorizontalFlip => 2,
        ExifOrientation::Rotate180 => 3,
        ExifOrientation::VerticalFlip => 4,
        ExifOrientation::Transpose => 5,
        ExifOrientation::Rotate90 => 6,
        ExifOrientation::Transverse => 7,
        ExifOrientation::Rotate270 => 8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repair_orientation_uses_tiff_codes_and_rejects_null() {
        for code in 1..=8 {
            assert_eq!(
                orientation_code(ExifOrientation::from_u16(code)),
                code as u32
            );
        }
        assert_eq!(unsafe { maple_raw_handle_orientation(std::ptr::null()) }, 0);
    }

    #[test]
    fn cropped_geometry_matches_each_orientation_and_round_trips() {
        let expected = [
            (10, 20, 60, 30),
            (30, 20, 60, 30),
            (30, 30, 60, 30),
            (10, 30, 60, 30),
            (20, 10, 30, 60),
            (30, 10, 30, 60),
            (30, 30, 30, 60),
            (20, 30, 30, 60),
        ];
        for (index, expected) in expected.into_iter().enumerate() {
            let orientation = ExifOrientation::from_u16(index as u16 + 1);
            let g = oriented_geometry(
                100,
                80,
                Some(CropRect {
                    x: 10,
                    y: 20,
                    w: 60,
                    h: 30,
                }),
                orientation,
            );
            assert_eq!((g.crop_x, g.crop_y, g.crop_width, g.crop_height), expected);
            assert_eq!(
                orientation.display_rect_to_sensor(
                    g.crop_x,
                    g.crop_y,
                    g.crop_width,
                    g.crop_height,
                    100,
                    80
                ),
                (10, 20, 60, 30)
            );
        }
    }

    #[test]
    fn clips_default_crop_and_rejects_degenerate_crop_like_full_develop() {
        let clipped = oriented_geometry(
            100,
            80,
            Some(CropRect {
                x: 90,
                y: 70,
                w: 50,
                h: 50,
            }),
            ExifOrientation::Normal,
        );
        assert_eq!((clipped.crop_width, clipped.crop_height), (10, 10));
        for crop in [
            None,
            Some(CropRect {
                x: 200,
                y: 0,
                w: 10,
                h: 10,
            }),
        ] {
            let g = oriented_geometry(100, 80, crop, ExifOrientation::Rotate90);
            assert_eq!(
                (g.crop_x, g.crop_y, g.crop_width, g.crop_height),
                (0, 0, 80, 100)
            );
        }
    }

    #[test]
    fn null_handle_clears_geometry() {
        let mut g = oriented_geometry(100, 80, None, ExifOrientation::Normal);
        assert_eq!(
            unsafe { maple_raw_handle_geometry(std::ptr::null(), &mut g) },
            1
        );
        assert_eq!(g, MapleRawGeometry::default());
    }
}

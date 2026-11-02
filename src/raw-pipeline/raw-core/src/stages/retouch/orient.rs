//! Repair spots are stored over the upright, display-oriented frame — the
//! convention masks use (`pipeline::mask`) — while the develop chain holds a
//! sensor-framed buffer. This maps the list into the buffer's frame so a spot
//! lands on the pixels the photographer clicked on an EXIF-rotated RAW (#4473).
//! A list still stamped with the legacy sensor frame is already in the
//! buffer's frame and passes through unchanged.

use std::borrow::Cow;

use crate::image::ExifOrientation;
use crate::pipeline::mask::display_to_sensor_norm;
use crate::types::retouch::{RetouchFrame, RetouchSpot};

/// `sensor` is the buffer's frame, `(width, height)`, before orientation.
/// `radius` is a fraction of the DISPLAY width, so it is re-expressed against
/// the sensor width to keep the same pixel radius.
pub(crate) fn orient_spots_to_sensor(
    spots: &[RetouchSpot],
    frame: RetouchFrame,
    orientation: ExifOrientation,
    sensor: (u32, u32),
) -> Cow<'_, [RetouchSpot]> {
    if frame == RetouchFrame::Sensor
        || orientation == ExifOrientation::Normal
        || spots.is_empty()
        || sensor.0 == 0
    {
        return Cow::Borrowed(spots);
    }
    let display_width = if orientation.swaps_wh() {
        sensor.1
    } else {
        sensor.0
    };
    let radius_scale = display_width as f32 / sensor.0 as f32;
    Cow::Owned(
        spots
            .iter()
            .map(|spot| RetouchSpot {
                center: display_to_sensor_norm(spot.center, orientation),
                source: display_to_sensor_norm(spot.source, orientation),
                radius: spot.radius * radius_scale,
                ..*spot
            })
            .collect(),
    )
}

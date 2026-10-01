//! Removal gestures follow the actual rounded crop rectangle and the renderer's
//! slice-then-orthogonal-rotate / rotate-then-slice branches (#3934).
use super::{needs_apply, rect_in_pixels, snap_orthogonal, OrthogonalSnap};
use crate::types::Crop;

/// Post-crop pixel-edge UV -> pre-crop pixel-edge UV. `size` is the actual
/// oriented input buffer dimensions before the crop stage, not asset metadata.
pub(crate) fn map_output_uv(crop: &Crop, size: [u32; 2], uv: [f32; 2]) -> Option<[f32; 2]> {
    let [w, h] = size;
    if w == 0
        || h == 0
        || uv
            .iter()
            .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
    {
        return None;
    }
    if !needs_apply(crop) {
        return Some(uv);
    }
    if !crop.angle.is_finite() {
        return None;
    }
    let (x, y, rw, rh) = rect_in_pixels(crop, w, h);
    let local = match snap_orthogonal(crop.angle) {
        OrthogonalSnap::Zero | OrthogonalSnap::Off => uv,
        OrthogonalSnap::Cw90 => [uv[1], 1.0 - uv[0]],
        OrthogonalSnap::Cw180 => [1.0 - uv[0], 1.0 - uv[1]],
        OrthogonalSnap::Cw270 => [1.0 - uv[1], uv[0]],
    };
    let point = [
        x as f32 + local[0] * rw as f32,
        y as f32 + local[1] * rh as f32,
    ];
    let point = if snap_orthogonal(crop.angle) == OrthogonalSnap::Off {
        super::bilinear::map_to_source(point, size, crop.angle)
    } else {
        point
    };
    let source = [point[0] / w as f32, point[1] / h as f32];
    source
        .iter()
        .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
        .then_some(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mapped_pixel_centres_match_actual_crop_output_at_orthogonal_and_free_angles() {
        let (w, h) = (31, 19);
        let pixels: Vec<f32> = (0..h)
            .flat_map(|y| {
                (0..w).flat_map(move |x| {
                    [
                        (x as f32 + 0.5) / w as f32,
                        (y as f32 + 0.5) / h as f32,
                        0.5,
                        1.0,
                    ]
                })
            })
            .collect();
        for angle in [0.0, 90.0, 180.0, 270.0, -90.0, 360.0, 90.005, 7.0, -13.0] {
            let crop = Crop {
                left: 0.17,
                right: 0.78,
                top: 0.21,
                bottom: 0.89,
                angle,
            };
            let (cw, ch, rendered) = super::super::apply_f32_rgba(&pixels, w, h, &crop);
            let mut compared = 0;
            for y in 0..ch {
                for x in 0..cw {
                    let uv = [(x as f32 + 0.5) / cw as f32, (y as f32 + 0.5) / ch as f32];
                    if let Some(source) = map_output_uv(&crop, [w, h], uv) {
                        // Exclude partially filled bilinear edge footprints;
                        // the continuous coordinate map does not blend fill.
                        if source[0] > 0.5 / w as f32
                            && source[0] < 1.0 - 0.5 / w as f32
                            && source[1] > 0.5 / h as f32
                            && source[1] < 1.0 - 0.5 / h as f32
                        {
                            let index = (y * cw + x) as usize * 4;
                            for axis in 0..2 {
                                assert!(
                                    (source[axis] - rendered[index + axis]).abs() < 2e-7,
                                    "{angle} {x},{y} {source:?}/{:?}",
                                    &rendered[index..index + 2]
                                );
                            }
                            compared += 1;
                        }
                    }
                }
            }
            assert!(compared > 100);
        }
    }

    #[test]
    fn surround_and_invalid_input_do_not_become_edge_strokes() {
        let crop = Crop {
            angle: 45.0,
            ..Crop::IDENTITY
        };
        assert_eq!(map_output_uv(&crop, [31, 19], [0.0, 0.0]), None);
        for point in [[-0.01, 0.5], [1.01, 0.5], [f32::NAN, 0.5]] {
            assert_eq!(map_output_uv(&Crop::IDENTITY, [31, 19], point), None);
        }
        assert_eq!(map_output_uv(&Crop::IDENTITY, [0, 19], [0.5; 2]), None);
    }
}

//! Empty frames (#3287): dehaze on a 0×N, N×0 or 0×0 image, or a window of
//! an empty frame, is a no-op, never a panic or a divide by zero.
use super::*;

const EMPTY: [(u32, u32); 3] = [(0, 7), (7, 0), (0, 0)];

fn image(width: u32, height: u32) -> Image {
    let mut img = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    img.pixels.iter_mut().for_each(|p| *p = [0.4, 0.5, 0.6]);
    img
}

#[test]
fn an_empty_image_dehazes_to_itself() {
    for (w, h) in EMPTY {
        for amount in [40.0, -40.0] {
            let mut img = image(w, h);
            apply(&mut img, amount);
            assert!(img.pixels.is_empty());
            let map = HazeMap::measure(&img);
            assert_eq!((map.width, map.height), (1, 1));
            apply_with_map(&mut img, amount, &map, (0, 0), (w, h));
            apply_whole_frame(&mut img, amount, None);
        }
    }
}

#[test]
fn an_empty_frame_or_map_leaves_a_window_unchanged() {
    let map = HazeMap::measure(&image(16, 12));
    let empty_map = HazeMap {
        width: 0,
        height: 0,
        coefficients: Vec::new(),
        sky: Vec::new(),
        ..map.clone()
    };
    for (w, h) in EMPTY {
        let mut img = image(4, 3);
        apply_with_map(&mut img, 40.0, &map, (0, 0), (w, h));
        apply_with_map(&mut img, 40.0, &empty_map, (0, 0), (16, 12));
        assert_eq!(img.pixels, image(4, 3).pixels);
    }
    assert_eq!(map::axis_taps(3, 0, 8), (0, 0, 0.0));
    assert_eq!(map::axis_taps(3, 8, 0), (0, 0, 0.0));
}

#[test]
fn measuring_an_empty_frames_maps_never_panics() {
    let model = crate::xmp::AdjustmentModel {
        dehaze: 40.0,
        ..Default::default()
    };
    for (w, h) in EMPTY {
        let measured = crate::pipeline::scene_linear_chain_haze_map(
            &[],
            w,
            h,
            &model,
            &crate::pipeline::ChainOptions::default(),
        );
        assert!(measured.map_or(true, |haze| haze.is_none_or(|haze| haze.covers(&model))));
    }
}

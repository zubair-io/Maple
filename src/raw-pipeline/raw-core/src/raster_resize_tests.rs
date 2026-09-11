use super::*;
use crate::raster_composite::Gravity;

/// 40x20 solid red — a 2:1 source, so every fit lands somewhere different
/// against a 10x10 square target.
fn wide() -> RasterImage {
    RasterImage::new_rgb(40, 20, vec![255, 0, 0].repeat(40 * 20))
}

fn opts(width: u32, height: u32, fit: ResizeFit) -> ResizeOptions {
    ResizeOptions {
        width,
        height,
        fit,
        filter: FilterAlg::Nearest,
        without_enlargement: false,
        without_reduction: false,
        position: Gravity::Centre,
        background: [0, 0, 255, 255],
    }
}

#[test]
fn inside_fits_within_both_dimensions() {
    let out = resize_raster(&wide(), &opts(10, 10, ResizeFit::Inside)).unwrap();
    assert_eq!((out.width, out.height), (10, 5));
}

#[test]
fn outside_covers_both_dimensions_without_cropping() {
    let out = resize_raster(&wide(), &opts(10, 10, ResizeFit::Outside)).unwrap();
    assert_eq!((out.width, out.height), (20, 10));
}

#[test]
fn cover_crops_to_the_exact_box() {
    let out = resize_raster(&wide(), &opts(10, 10, ResizeFit::Cover)).unwrap();
    assert_eq!((out.width, out.height), (10, 10));
}

#[test]
fn contain_letterboxes_to_the_exact_box() {
    let out = resize_raster(&wide(), &opts(10, 10, ResizeFit::Contain)).unwrap();
    assert_eq!((out.width, out.height), (10, 10));
    // Scaled source is 10x5; centring rounds the 5px of slack down, so the
    // top band gets 2 rows and the bottom band gets 3: rows 0-1 and 7-9 are
    // the blue letterbox, rows 2-6 are the image.
    let px = |x: u32, y: u32| {
        let i = ((y * out.width + x) * out.channels as u32) as usize;
        [out.data[i], out.data[i + 1], out.data[i + 2]]
    };
    assert_eq!(px(5, 0), [0, 0, 255]);
    assert_eq!(px(5, 1), [0, 0, 255], "last row of the top band");
    assert_eq!(px(5, 5), [255, 0, 0]);
    assert_eq!(px(5, 7), [0, 0, 255], "first row of the bottom band");
    assert_eq!(px(5, 9), [0, 0, 255]);
}

#[test]
fn contain_with_a_transparent_background_produces_rgba() {
    let mut o = opts(10, 10, ResizeFit::Contain);
    o.background = [0, 0, 0, 0];
    let out = resize_raster(&wide(), &o).unwrap();
    assert_eq!(out.channels, 4);
    assert_eq!(out.data[3], 0, "the letterbox band must be transparent");
}

#[test]
fn contain_respects_position_for_the_pad_side() {
    // A wide source into a taller-than-wide box pads top/bottom; a 'north'
    // gravity should push the image to the top, so the letterbox band sits
    // at the bottom rather than being split evenly.
    let mut o = opts(10, 10, ResizeFit::Contain);
    o.position = Gravity::North;
    let out = resize_raster(&wide(), &o).unwrap();
    let px = |x: u32, y: u32| {
        let i = ((y * out.width + x) * out.channels as u32) as usize;
        [out.data[i], out.data[i + 1], out.data[i + 2]]
    };
    assert_eq!(px(5, 0), [255, 0, 0], "image sits flush against the top");
    assert_eq!(
        px(5, 9),
        [0, 0, 255],
        "letterbox band is pushed to the bottom"
    );
}

#[test]
fn cover_respects_position_for_the_crop_side() {
    // 4x2 source, left half red and right half green; a 2x2 cover crop at
    // 'west' keeps red, at 'east' keeps green.
    let src = RasterImage::new_rgb(
        4,
        2,
        vec![
            255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, // row 0
            255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, // row 1
        ],
    );
    let mut o = opts(2, 2, ResizeFit::Cover);
    o.filter = FilterAlg::Nearest;

    o.position = Gravity::West;
    let west = resize_raster(&src, &o).unwrap();
    assert_eq!(&west.data[..3], &[255, 0, 0]);

    o.position = Gravity::East;
    let east = resize_raster(&src, &o).unwrap();
    assert_eq!(&east.data[..3], &[0, 255, 0]);
}

#[test]
fn without_enlargement_refuses_to_scale_up() {
    let small = RasterImage::new_rgb(4, 4, vec![9; 48]);
    let mut o = opts(20, 20, ResizeFit::Inside);
    o.without_enlargement = true;
    assert_eq!(resize_raster(&small, &o).unwrap().width, 4);
}

#[test]
fn without_reduction_refuses_to_scale_down() {
    let mut o = opts(10, 10, ResizeFit::Inside);
    o.without_reduction = true;
    // The source is bigger than the box, so the scale is clamped to 1.
    let out = resize_raster(&wide(), &o).unwrap();
    assert_eq!((out.width, out.height), (40, 20));
}

#[test]
fn without_reduction_still_crops_for_cover() {
    // sharp: "This may still result in a crop to reach the target
    // dimensions."
    let mut o = opts(10, 10, ResizeFit::Cover);
    o.without_reduction = true;
    let out = resize_raster(&wide(), &o).unwrap();
    assert_eq!((out.width, out.height), (10, 10));
}

#[test]
fn without_reduction_and_without_enlargement_together_return_the_source_unchanged() {
    // sharp: when both are set and the target differs, the source comes
    // back as-is — the enlargement clamp pins the scale at <= 1, the
    // reduction clamp pins it at >= 1, so 1.0 is the only value left.
    let mut o = opts(10, 10, ResizeFit::Inside);
    o.without_enlargement = true;
    o.without_reduction = true;
    let out = resize_raster(&wide(), &o).unwrap();
    assert_eq!((out.width, out.height), (40, 20));
    assert_eq!(out.data, wide().data);
}

#[test]
fn contain_promotes_a_3_channel_source_to_4_for_a_translucent_background() {
    let out = resize_raster(
        &wide(),
        &ResizeOptions {
            background: [10, 20, 30, 128],
            ..opts(10, 10, ResizeFit::Contain)
        },
    )
    .unwrap();
    assert_eq!(out.channels, 4);
}

#[test]
fn cover_and_contain_are_unaffected_by_extreme_aspect_ratios() {
    let tall = RasterImage::new_rgb(5, 50, vec![1, 2, 3].repeat(5 * 50));
    let cover = resize_raster(&tall, &opts(20, 20, ResizeFit::Cover)).unwrap();
    assert_eq!((cover.width, cover.height), (20, 20));
    let contain = resize_raster(&tall, &opts(20, 20, ResizeFit::Contain)).unwrap();
    assert_eq!((contain.width, contain.height), (20, 20));
}

/// A 2x2 RGBA source: an opaque red pixel on the left, a fully transparent
/// green pixel on the right, on both rows. Downscaling to 1 pixel wide
/// averages each row's two source pixels together.
fn half_red_half_transparent_green() -> RasterImage {
    RasterImage::new_rgba(
        2,
        2,
        vec![
            255, 0, 0, 255, 0, 255, 0, 0, // row 0: opaque red, transparent green
            255, 0, 0, 255, 0, 255, 0, 0, // row 1: opaque red, transparent green
        ],
    )
}

#[test]
fn downscaling_rgba_premultiplies_so_transparent_colour_does_not_bleed() {
    let out = resize_raster(
        &half_red_half_transparent_green(),
        &ResizeOptions {
            width: 1,
            height: 2,
            fit: ResizeFit::Fill,
            filter: FilterAlg::Bilinear,
            without_enlargement: false,
            without_reduction: false,
            position: Gravity::Centre,
            background: [0, 0, 0, 255],
        },
    )
    .unwrap();
    assert_eq!((out.width, out.height, out.channels), (1, 2, 4));
    for px in out.data.chunks_exact(4) {
        let [r, g, _b, a] = [px[0], px[1], px[2], px[3]];
        if a > 0 {
            assert_eq!(
                g, 0,
                "the transparent green neighbour must not tint green in"
            );
            assert_eq!(
                r, 255,
                "the opaque red survivor must stay fully red, not diluted"
            );
        }
    }
}

#[test]
fn a_3_channel_downscale_is_unaffected_by_the_premultiply_path() {
    // Same red/green split as the RGBA case, but opaque throughout (no
    // alpha channel) — straight averaging is correct here, so this must
    // take the untouched 3-channel path and blend the two colours.
    let src = RasterImage::new_rgb(
        2,
        2,
        vec![
            255, 0, 0, 0, 255, 0, // row 0: red, green
            255, 0, 0, 0, 255, 0, // row 1: red, green
        ],
    );
    let out = resize_raster(
        &src,
        &ResizeOptions {
            width: 1,
            height: 2,
            fit: ResizeFit::Fill,
            filter: FilterAlg::Bilinear,
            without_enlargement: false,
            without_reduction: false,
            position: Gravity::Centre,
            background: [0, 0, 0, 255],
        },
    )
    .unwrap();
    assert_eq!((out.width, out.height, out.channels), (1, 2, 3));
    for px in out.data.chunks_exact(3) {
        assert!(
            px[0] > 0 && px[1] > 0,
            "opaque red and green blend together"
        );
    }
}

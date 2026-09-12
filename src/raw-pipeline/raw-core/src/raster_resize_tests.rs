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

/// A source whose red channel names its own column (`x * 6 + 3`), so an
/// output pixel says which source column it came from.
fn columns(w: u32, h: u32) -> RasterImage {
    let data = (0..h)
        .flat_map(|_| (0..w).flat_map(|x| [(x * 6 + 3) as u8, 0, 0]))
        .collect();
    RasterImage::new_rgb(w, h, data)
}

/// sharp centres a CROP by rounding the slack up — `CalculateCrop` in
/// `src/common.cc` is `(in - out + 1) / 2`. Measured against sharp 0.34.5 /
/// libvips 8.17.3: a 20x10 source covered into a 9x10 box needs no scaling
/// (the height already matches and cover takes the smaller shrink), so the
/// crop does all the work, and the first output column is source x = 6.
/// Rounding the 11px slack down gives 5.
#[test]
fn cover_centres_an_odd_slack_crop_by_rounding_up() {
    let out = resize_raster(&columns(20, 10), &opts(9, 10, ResizeFit::Cover)).unwrap();
    assert_eq!((out.width, out.height), (9, 10));
    assert_eq!(out.data[0], 6 * 6 + 3, "first column must be source x = 6");
}

/// The same bias on a source that really is resampled. 400x200 covered into
/// 63x63 scales by 63/200, giving a 126x63 intermediate, and the crop keeps
/// 63 of those 126 columns — 63px of slack, odd. sharp: left = 32.
#[test]
fn cover_rounds_up_the_crop_offset_on_a_downscaled_source() {
    let src = columns(400, 200);
    let cover = resize_raster(&src, &opts(63, 63, ResizeFit::Cover)).unwrap();
    assert_eq!((cover.width, cover.height), (63, 63));
    let scaled = resize_raster(&src, &opts(126, 63, ResizeFit::Fill)).unwrap();
    assert_eq!((scaled.width, scaled.height), (126, 63));
    assert_eq!(cover.data, scaled.crop(32, 0, 63, 63).unwrap().data);
    assert_ne!(cover.data, scaled.crop(31, 0, 63, 63).unwrap().data);
}

/// An even slack rounds the same way either side of the fix, so this case
/// pins that the change is confined to odd slack: 20x10 into a 10x10 cover
/// box leaves 10px of slack and starts at source x = 5 both ways.
#[test]
fn an_even_slack_cover_crop_is_unmoved() {
    let out = resize_raster(&columns(20, 10), &opts(10, 10, ResizeFit::Cover)).unwrap();
    assert_eq!((out.width, out.height), (10, 10));
    assert_eq!(out.data[0], 5 * 6 + 3, "first column must be source x = 5");
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

/// A 32x32 checkerboard — the pathological input for a resampler, so
/// different kernels genuinely produce different bytes.
fn checker() -> RasterImage {
    let data = (0..32u32)
        .flat_map(|y| {
            (0..32u32).flat_map(move |x| {
                if (x + y) % 2 == 0 {
                    [255u8, 0, 0]
                } else {
                    [0, 0, 255]
                }
            })
        })
        .collect();
    RasterImage::new_rgb(32, 32, data)
}

#[test]
fn every_kernel_resamples_and_they_are_not_all_identical() {
    // 11x11, not the more obvious 9x9: the checkerboard alternates at
    // Nyquist frequency, so several downscale ratios (9x9 among them) make
    // multiple kernels converge on the exact same rounded midpoint by
    // construction, not by any implementation coincidence — 11x11 is
    // confirmed clean of that effect.
    let kernels = [
        FilterAlg::Nearest,
        FilterAlg::Bilinear,
        FilterAlg::CatmullRom,
        FilterAlg::Mitchell,
        FilterAlg::Lanczos2,
        FilterAlg::Lanczos3,
    ];
    let results: Vec<Vec<u8>> = kernels
        .iter()
        .map(|&filter| {
            let mut o = opts(11, 11, ResizeFit::Fill);
            o.filter = filter;
            let out = resize_raster(&checker(), &o).unwrap();
            assert_eq!((out.width, out.height), (11, 11));
            out.data
        })
        .collect();
    for i in 0..results.len() {
        for j in i + 1..results.len() {
            assert_ne!(
                results[i], results[j],
                "kernels {:?} and {:?} produced identical output",
                kernels[i], kernels[j]
            );
        }
    }
}

/// The three new kernels: catmull-rom, mitchell, lanczos2.
const NEW_KERNELS: [FilterAlg; 3] = [
    FilterAlg::CatmullRom,
    FilterAlg::Mitchell,
    FilterAlg::Lanczos2,
];

#[test]
fn every_new_kernel_leaves_a_flat_image_unchanged() {
    let flat = RasterImage::new_rgb(8, 8, vec![137u8; 8 * 8 * 3]);
    for filter in NEW_KERNELS {
        let mut o = opts(3, 3, ResizeFit::Fill);
        o.filter = filter;
        let out = resize_raster(&flat, &o).unwrap();
        assert!(
            out.data.iter().all(|&b| b == 137),
            "{filter:?} did not leave a flat image unchanged: {:?}",
            out.data
        );
    }
}

/// A 2-pixel-wide hard edge: downscaling to 1 pixel forces the kernel to
/// blend exactly the two source samples, with no interior neighbours to
/// draw from, so this is the simplest case a well-behaved kernel handles
/// without ringing.
#[test]
fn every_new_kernel_blends_a_2_pixel_edge_between_the_source_values() {
    let src = RasterImage::new_rgb(2, 1, vec![40, 40, 40, 220, 220, 220]);
    for filter in NEW_KERNELS {
        let mut o = opts(1, 1, ResizeFit::Fill);
        o.filter = filter;
        let out = resize_raster(&src, &o).unwrap();
        let v = out.data[0];
        assert!(
            (40..=220).contains(&v),
            "{filter:?} produced {v}, outside the source range [40, 220]"
        );
    }
}

/// A wide flat-40 / flat-220 step, downscaled 2x. Convolution kernels with
/// negative lobes overshoot past the flat regions near the transition
/// ("ringing"). Mitchell (B = C = 1/3) is tuned to ring less than
/// Catmull-Rom, and both ring markedly less than Lanczos3's wider window —
/// and all three land on different bytes than Lanczos3 at the edge.
#[test]
fn mitchell_and_cubic_ring_less_than_lanczos3_on_a_hard_edge() {
    let mut data = Vec::new();
    for x in 0..64u32 {
        let v = if x < 32 { 40u8 } else { 220u8 };
        data.extend_from_slice(&[v, v, v]);
    }
    let src = RasterImage::new_rgb(64, 1, data);

    let resampled = |filter: FilterAlg| -> Vec<u8> {
        let mut o = opts(32, 1, ResizeFit::Fill);
        o.filter = filter;
        resize_raster(&src, &o).unwrap().data
    };
    let overshoot = |data: &[u8]| -> u8 {
        data.iter()
            .map(|&b| {
                if b < 40 {
                    40 - b
                } else if b > 220 {
                    b - 220
                } else {
                    0
                }
            })
            .max()
            .unwrap()
    };

    let lanczos3 = resampled(FilterAlg::Lanczos3);
    let lanczos3_overshoot = overshoot(&lanczos3);

    for filter in [FilterAlg::CatmullRom, FilterAlg::Mitchell] {
        let out = resampled(filter);
        assert_ne!(
            out, lanczos3,
            "{filter:?} produced the same bytes as lanczos3 at a hard edge"
        );
        assert!(
            overshoot(&out) < lanczos3_overshoot,
            "{filter:?} overshoot {} should be smaller than lanczos3's {lanczos3_overshoot}",
            overshoot(&out)
        );
    }
}

#[test]
fn every_new_kernel_premultiplies_alpha_for_a_4_channel_downscale() {
    for filter in NEW_KERNELS {
        let out = resize_raster(
            &half_red_half_transparent_green(),
            &ResizeOptions {
                width: 1,
                height: 2,
                fit: ResizeFit::Fill,
                filter,
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
                    "{filter:?}: transparent green neighbour must not tint green in"
                );
                assert_eq!(
                    r, 255,
                    "{filter:?}: opaque red survivor must stay fully red, not diluted"
                );
            }
        }
    }
}

#[path = "raster_resize_fit_tests.rs"]
mod fit;

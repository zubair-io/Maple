use super::*;

fn solid_rgba(w: u32, h: u32, px: [u8; 4]) -> RasterImage {
    RasterImage::new_rgba(w, h, (0..w * h).flat_map(|_| px).collect())
}

fn layer<'a>(image: &'a RasterImage, blend: BlendMode) -> CompositeLayer<'a> {
    CompositeLayer {
        image,
        left: Some(0),
        top: Some(0),
        gravity: Gravity::Centre,
        blend,
        tile: false,
    }
}

#[test]
fn opaque_over_replaces_the_base() {
    let base = solid_rgba(2, 2, [10, 20, 30, 255]);
    let over = solid_rgba(2, 2, [200, 100, 50, 255]);
    let out = composite(&base, &[layer(&over, BlendMode::Over)]).unwrap();
    assert_eq!(&out.data[..4], &[200, 100, 50, 255]);
}

#[test]
fn a_fully_transparent_layer_changes_nothing() {
    let base = solid_rgba(1, 1, [10, 20, 30, 255]);
    let over = solid_rgba(1, 1, [200, 100, 50, 0]);
    let out = composite(&base, &[layer(&over, BlendMode::Over)]).unwrap();
    assert_eq!(out.data, vec![10, 20, 30, 255]);
}

#[test]
fn half_alpha_over_is_the_midpoint() {
    let base = solid_rgba(1, 1, [0, 0, 0, 255]);
    let over = solid_rgba(1, 1, [255, 255, 255, 128]);
    let out = composite(&base, &[layer(&over, BlendMode::Over)]).unwrap();
    // 255·(128/255) + 0·(1 - 128/255) = 128
    assert_eq!(&out.data[..3], &[128, 128, 128]);
    assert_eq!(out.data[3], 255);
}

#[test]
fn multiply_screen_darken_lighten_are_closed_form_on_opaque_pixels() {
    let base = solid_rgba(1, 1, [200, 100, 50, 255]);
    let src = solid_rgba(1, 1, [128, 128, 128, 255]);
    let run = |b| composite(&base, &[layer(&src, b)]).unwrap().data;
    // multiply: 200·128/255 = 100.4 → 100, 100·128/255 = 50.2 → 50, 50·128/255 = 25.1 → 25
    assert_eq!(&run(BlendMode::Multiply)[..3], &[100, 50, 25]);
    // screen: cb + cs - cb·cs → 200+128-100 = 228, 100+128-50 = 178, 50+128-25 = 153
    assert_eq!(&run(BlendMode::Screen)[..3], &[228, 178, 153]);
    assert_eq!(&run(BlendMode::Darken)[..3], &[128, 100, 50]);
    assert_eq!(&run(BlendMode::Lighten)[..3], &[200, 128, 128]);
}

#[test]
fn compositing_onto_a_3_channel_base_yields_a_4_channel_result() {
    let base = RasterImage::new_rgb(1, 1, vec![10, 20, 30]);
    let overlay = solid_rgba(1, 1, [200, 100, 50, 255]);
    let out = composite(&base, &[layer(&overlay, BlendMode::Over)]).unwrap();
    assert_eq!(out.channels, 4);
    assert_eq!(out.data.len(), 4);
}

#[test]
fn multiply_blends_a_half_transparent_overlay_against_the_base() {
    // Multiply is separable: Co = (1-As)·Cb·Ab + As·Ab·(Cb·Cs) + (1-Ab)·Cs·As;
    // with an opaque base (Ab=1) that's Co = (1-As)·Cb + As·(Cb·Cs). A
    // half-transparent BLACK overlay (Cs=0) collapses the multiply term to
    // 0, leaving Co = (1-As)·Cb — the opaque white base darkened by exactly
    // the overlay's alpha: (1 - 128/255)·255 = 127 exactly, alpha stays 255
    // (opaque base, opaque result).
    let base = solid_rgba(1, 1, [255, 255, 255, 255]);
    let overlay = solid_rgba(1, 1, [0, 0, 0, 128]);
    let out = composite(&base, &[layer(&overlay, BlendMode::Multiply)]).unwrap();
    assert_eq!(&out.data[..3], &[127, 127, 127]);
    assert_eq!(out.data[3], 255);
}

/// A tiled layer's offset comes straight off the wire recipe — untrusted.
/// `ceil_div`'s `a + b - 1` step is the one that can overflow: with
/// `origin = i64::MAX - 1` and a 3px-wide overlay, `origin + (3 - 1)`
/// overflows `i64::MAX` by one. Must return an error, not wrap or panic.
#[test]
fn a_near_i64_max_tile_offset_is_rejected_not_overflowed() {
    let base = solid_rgba(5, 5, [0, 0, 0, 255]);
    let dot = solid_rgba(3, 3, [255, 0, 0, 255]);
    let placed = CompositeLayer {
        tile: true,
        left: Some(i64::MAX - 1),
        top: Some(0),
        ..layer(&dot, BlendMode::Over)
    };
    assert!(composite(&base, &[placed]).is_err());
}

#[test]
fn add_saturates_at_255() {
    let base = solid_rgba(1, 1, [200, 10, 0, 255]);
    let src = solid_rgba(1, 1, [100, 10, 0, 255]);
    let out = composite(&base, &[layer(&src, BlendMode::Add)]).unwrap();
    assert_eq!(&out.data[..3], &[255, 20, 0]);
}

#[test]
fn dest_in_and_dest_out_use_the_source_as_a_mask() {
    let base = solid_rgba(1, 1, [90, 90, 90, 255]);
    let mask = solid_rgba(1, 1, [0, 0, 0, 128]);
    let inside = composite(&base, &[layer(&mask, BlendMode::DestIn)]).unwrap();
    assert_eq!(inside.data[3], 128);
    assert_eq!(&inside.data[..3], &[90, 90, 90]);
    let outside = composite(&base, &[layer(&mask, BlendMode::DestOut)]).unwrap();
    assert_eq!(outside.data[3], 127);
}

#[test]
fn a_smaller_layer_only_touches_its_own_rectangle() {
    let base = solid_rgba(3, 1, [0, 0, 0, 255]);
    let dot = solid_rgba(1, 1, [255, 255, 255, 255]);
    let placed = CompositeLayer {
        left: Some(1),
        top: Some(0),
        ..layer(&dot, BlendMode::Over)
    };
    let out = composite(&base, &[placed]).unwrap();
    assert_eq!(&out.data[..4], &[0, 0, 0, 255]);
    assert_eq!(&out.data[4..8], &[255, 255, 255, 255]);
    assert_eq!(&out.data[8..12], &[0, 0, 0, 255]);
}

#[test]
fn gravity_places_the_layer_when_left_and_top_are_absent() {
    // 6px of slack on each axis — even, so the crop bias is invisible here.
    assert_eq!(Gravity::Centre.place_crop((10, 10), (4, 4)), (3, 3));
    assert_eq!(Gravity::NorthWest.place_crop((10, 10), (4, 4)), (0, 0));
    assert_eq!(Gravity::SouthEast.place_crop((10, 10), (4, 4)), (6, 6));
    assert_eq!(Gravity::East.place_crop((10, 10), (4, 4)), (6, 3));
    assert_eq!(Gravity::South.place_crop((10, 10), (4, 4)), (3, 6));
}

/// A composite overlay is placed by sharp's `CalculateCrop`, which rounds an
/// odd slack UP. Measured against sharp 0.34.5 / libvips 8.17.3: a 3x3
/// overlay at `gravity: 'centre'` on a 10x10 base lands at left = top = 4,
/// covering columns and rows 4..6 — not the 3 that rounding down gives.
#[test]
fn an_odd_slack_centre_gravity_rounds_the_overlay_towards_the_far_edge() {
    assert_eq!(Gravity::Centre.place_crop((10, 10), (3, 3)), (4, 4));

    let base = solid_rgba(10, 10, [0, 0, 0, 255]);
    let dot = solid_rgba(3, 3, [255, 255, 255, 255]);
    let placed = CompositeLayer {
        left: None,
        top: None,
        ..layer(&dot, BlendMode::Over)
    };
    let out = composite(&base, &[placed]).unwrap();
    let lit = |x: u32, y: u32| out.data[((y * 10 + x) * 4) as usize] == 255;
    assert!(!lit(3, 5), "column 3 must stay base");
    assert!(lit(4, 5), "column 4 is the overlay's first column");
    assert!(lit(6, 5), "column 6 is the overlay's last column");
    assert!(!lit(7, 5), "column 7 must stay base");
}

/// The pad centring is the other bias: an odd slack rounds DOWN, so the two
/// helpers disagree by one pixel on the same numbers. sharp's
/// `CalculateEmbedPosition` is what makes `contain` letterbox this way.
#[test]
fn pad_centring_rounds_the_opposite_way_from_crop_centring() {
    assert_eq!(Gravity::Centre.place_pad((10, 10), (3, 3)), (3, 3));
    assert_eq!(Gravity::Centre.place_crop((10, 10), (3, 3)), (4, 4));
    // An even slack agrees.
    assert_eq!(Gravity::Centre.place_pad((10, 10), (4, 4)), (3, 3));
    assert_eq!(Gravity::Centre.place_crop((10, 10), (4, 4)), (3, 3));
}

#[test]
fn tile_repeats_the_layer_across_the_base() {
    let base = solid_rgba(4, 1, [0, 0, 0, 255]);
    let dot = solid_rgba(2, 1, [255, 0, 0, 255]);
    let tiled = CompositeLayer {
        tile: true,
        ..layer(&dot, BlendMode::Over)
    };
    let out = composite(&base, &[tiled]).unwrap();
    assert!(out.data.chunks_exact(4).all(|px| px[0] == 255));
}

#[test]
fn a_layer_larger_than_the_base_is_rejected() {
    let base = solid_rgba(2, 2, [0, 0, 0, 255]);
    let big = solid_rgba(4, 4, [0, 0, 0, 255]);
    assert!(composite(&base, &[layer(&big, BlendMode::Over)]).is_err());
}

#[test]
fn a_zero_size_overlay_is_rejected_before_any_arithmetic() {
    let base = solid_rgba(2, 2, [0, 0, 0, 255]);
    let empty = RasterImage::new_rgba(0, 3, vec![]);
    let placed = CompositeLayer {
        tile: true,
        ..layer(&empty, BlendMode::Over)
    };
    assert!(composite(&base, &[placed]).is_err());
}

#[test]
fn tiling_covers_the_whole_canvas_not_just_from_the_placed_origin() {
    // A 5x5 base with a 2x2 overlay tiled from a Centre placement: the
    // origin lands at (1,1) — off-grid for a 2px tile — so the untiled
    // strip bug would leave column/row 0 and the last column/row
    // (index 4) unpainted. Every corner must still be overlay-derived.
    let base = solid_rgba(5, 5, [0, 0, 0, 255]);
    let dot = solid_rgba(2, 2, [255, 0, 0, 255]);
    let placed = CompositeLayer {
        tile: true,
        gravity: Gravity::Centre,
        left: None,
        top: None,
        ..layer(&dot, BlendMode::Over)
    };
    let out = composite(&base, &[placed]).unwrap();
    assert!(out.data.chunks_exact(4).all(|px| px[0] == 255));
}

#[test]
fn southeast_tiling_still_covers_the_near_edge() {
    let base = solid_rgba(5, 5, [0, 0, 0, 255]);
    let dot = solid_rgba(2, 2, [255, 0, 0, 255]);
    let placed = CompositeLayer {
        tile: true,
        gravity: Gravity::SouthEast,
        left: None,
        top: None,
        ..layer(&dot, BlendMode::Over)
    };
    let out = composite(&base, &[placed]).unwrap();
    let idx = |x: u32, y: u32| ((y * 5 + x) * 4) as usize;
    assert_eq!(out.data[idx(0, 0)], 255);
    assert_eq!(out.data[idx(4, 4)], 255);
}

#[test]
fn exactly_one_of_left_or_top_is_rejected() {
    let base = solid_rgba(2, 2, [0, 0, 0, 255]);
    let dot = solid_rgba(1, 1, [255, 255, 255, 255]);
    let only_left = CompositeLayer {
        left: Some(0),
        top: None,
        ..layer(&dot, BlendMode::Over)
    };
    let err = composite(&base, &[only_left]).unwrap_err();
    assert!(err
        .to_string()
        .contains("composite: a layer must set both left and top, or neither"));

    let only_top = CompositeLayer {
        left: None,
        top: Some(0),
        ..layer(&dot, BlendMode::Over)
    };
    assert!(composite(&base, &[only_top]).is_err());
}

#[test]
fn wire_spellings_round_trip() {
    assert_eq!(BlendMode::from_wire("dest-in"), Some(BlendMode::DestIn));
    assert_eq!(BlendMode::from_wire("overlay"), None);
    assert_eq!(Gravity::from_wire("center"), Some(Gravity::Centre));
    assert_eq!(Gravity::from_wire("northeast"), Some(Gravity::NorthEast));
    assert_eq!(Gravity::from_wire("entropy"), None);
}

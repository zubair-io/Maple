//! Layer compositing for `RasterImage` (#3505).
//!
//! Blending runs in the image's own sRGB-encoded 8-bit space, premultiplied,
//! matching `vips_composite` — NOT in linear light. That choice is deliberate:
//! the package exists so a caller can swap `sharp` for `maple` and get the
//! same bytes out, and libvips composites in the working colourspace.
//!
//! The formulae are Porter-Duff / PDF separable blending on premultiplied
//! values in `[0, 1]`:
//!
//! ```text
//! over:     Co = Cs + Cb·(1 - As)                 Ao = As + Ab·(1 - As)
//! add:      Co = min(1, Cs + Cb)                  Ao = min(1, As + Ab)
//! dest-in:  Co = Cb·As                            Ao = Ab·As
//! dest-out: Co = Cb·(1 - As)                      Ao = Ab·(1 - As)
//! separable (multiply, screen, darken, lighten), on STRAIGHT values cs, cb:
//!           Co = (1-Ab)·Cs + (1-As)·Cb + As·Ab·B(cb, cs)
//!           Ao = As + Ab·(1 - As)
//! ```

use crate::error::{Error, Result};
use crate::raster::RasterImage;

/// The eight blend modes #3505 asks for. sharp/libvips expose more
/// (`overlay`, `soft-light`, `colour-dodge`, …); those are not in the issue
/// and `from_wire` returns `None` for them so the caller gets a named error
/// instead of a silent `over`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlendMode {
    Over,
    Multiply,
    Screen,
    Add,
    Darken,
    Lighten,
    DestIn,
    DestOut,
}

impl BlendMode {
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "over" => Some(Self::Over),
            "multiply" => Some(Self::Multiply),
            "screen" => Some(Self::Screen),
            "add" => Some(Self::Add),
            "darken" => Some(Self::Darken),
            "lighten" => Some(Self::Lighten),
            "dest-in" => Some(Self::DestIn),
            "dest-out" => Some(Self::DestOut),
            _ => None,
        }
    }

    /// Separable blend function `B(cb, cs)` on straight values in `[0, 1]`.
    /// `None` for the modes that are not separable (they are handled
    /// directly on premultiplied values).
    fn separable(self) -> Option<fn(f32, f32) -> f32> {
        match self {
            Self::Multiply => Some(|cb, cs| cb * cs),
            Self::Screen => Some(|cb, cs| cb + cs - cb * cs),
            Self::Darken => Some(|cb, cs| cb.min(cs)),
            Self::Lighten => Some(|cb, cs| cb.max(cs)),
            _ => None,
        }
    }
}

/// The nine fixed placements sharp calls `gravity`. The `position` spellings
/// (`top`, `right top`, …) map onto the same nine and are translated in the
/// package before they reach the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Gravity {
    #[default]
    Centre,
    North,
    NorthEast,
    East,
    SouthEast,
    South,
    SouthWest,
    West,
    NorthWest,
}

impl Gravity {
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "centre" | "center" => Some(Self::Centre),
            "north" => Some(Self::North),
            "northeast" => Some(Self::NorthEast),
            "east" => Some(Self::East),
            "southeast" => Some(Self::SouthEast),
            "south" => Some(Self::South),
            "southwest" => Some(Self::SouthWest),
            "west" => Some(Self::West),
            "northwest" => Some(Self::NorthWest),
            _ => None,
        }
    }

    /// Top-left corner at which an `inner` box sits inside an `outer` box.
    /// Centring rounds down, matching libvips' integer arithmetic.
    pub fn place(self, outer: (u32, u32), inner: (u32, u32)) -> (i64, i64) {
        let (ow, oh) = (outer.0 as i64, outer.1 as i64);
        let (iw, ih) = (inner.0 as i64, inner.1 as i64);
        let (mid_x, mid_y) = ((ow - iw) / 2, (oh - ih) / 2);
        match self {
            Self::Centre => (mid_x, mid_y),
            Self::North => (mid_x, 0),
            Self::NorthEast => (ow - iw, 0),
            Self::East => (ow - iw, mid_y),
            Self::SouthEast => (ow - iw, oh - ih),
            Self::South => (mid_x, oh - ih),
            Self::SouthWest => (0, oh - ih),
            Self::West => (0, mid_y),
            Self::NorthWest => (0, 0),
        }
    }
}

/// One overlay in a `composite` call.
pub struct CompositeLayer<'a> {
    pub image: &'a RasterImage,
    /// Explicit offsets win over `gravity` when BOTH are given, matching sharp.
    pub left: Option<i64>,
    pub top: Option<i64>,
    pub gravity: Gravity,
    pub blend: BlendMode,
    pub tile: bool,
}

#[inline]
fn to_unit(v: u8) -> f32 {
    v as f32 / 255.0
}

#[inline]
fn to_byte(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Blend one straight-alpha source pixel onto one straight-alpha base pixel.
fn blend_pixel(base: [u8; 4], src: [u8; 4], mode: BlendMode) -> [u8; 4] {
    let ab = to_unit(base[3]);
    let a_s = to_unit(src[3]);
    let cb = [0, 1, 2].map(|i| to_unit(base[i]));
    let cs = [0, 1, 2].map(|i| to_unit(src[i]));
    // Premultiplied.
    let pb = cb.map(|c| c * ab);
    let ps = cs.map(|c| c * a_s);

    let (ao, po) = match mode {
        BlendMode::Over => (
            a_s + ab * (1.0 - a_s),
            [0, 1, 2].map(|i| ps[i] + pb[i] * (1.0 - a_s)),
        ),
        BlendMode::Add => (
            (a_s + ab).min(1.0),
            [0, 1, 2].map(|i| (ps[i] + pb[i]).min(1.0)),
        ),
        BlendMode::DestIn => (ab * a_s, [0, 1, 2].map(|i| pb[i] * a_s)),
        BlendMode::DestOut => (ab * (1.0 - a_s), [0, 1, 2].map(|i| pb[i] * (1.0 - a_s))),
        other => {
            // `separable` is Some for exactly the four remaining variants.
            let f = other
                .separable()
                .expect("non-separable blend handled above");
            (
                a_s + ab * (1.0 - a_s),
                [0, 1, 2]
                    .map(|i| (1.0 - ab) * ps[i] + (1.0 - a_s) * pb[i] + a_s * ab * f(cb[i], cs[i])),
            )
        }
    };

    if ao <= 0.0 {
        return [0, 0, 0, 0];
    }
    let out = [0, 1, 2].map(|i| to_byte(po[i] / ao));
    [out[0], out[1], out[2], to_byte(ao)]
}

/// Composite `layers` onto `base`, in order. The result always carries an
/// alpha channel; callers that want RGB out run `remove_alpha` or `flatten`
/// afterwards (the recipe executor does exactly that at encode time).
pub fn composite(base: &RasterImage, layers: &[CompositeLayer<'_>]) -> Result<RasterImage> {
    let mut out = base.ensure_alpha(255);
    let (bw, bh) = (out.width as i64, out.height as i64);
    for layer in layers {
        if layer.image.width > out.width || layer.image.height > out.height {
            return Err(Error::Decode {
                path: "<memory>".into(),
                reason: format!(
                    "composite layer {}x{} is larger than the base {}x{}",
                    layer.image.width, layer.image.height, out.width, out.height
                ),
            });
        }
        let src = layer.image.ensure_alpha(255);
        let (ox, oy) = match (layer.left, layer.top) {
            (Some(x), Some(y)) => (x, y),
            _ => layer
                .gravity
                .place((out.width, out.height), (src.width, src.height)),
        };
        // `bw`/`bh`/`src.width`/`src.height` are always positive, so plain
        // ceiling division is exact here (`i64::div_ceil` is unstable).
        let steps_x: Vec<i64> = if layer.tile {
            let tiles = (bw + src.width as i64 - 1) / src.width as i64;
            (0..tiles).map(|i| ox + i * src.width as i64).collect()
        } else {
            vec![ox]
        };
        let steps_y: Vec<i64> = if layer.tile {
            let tiles = (bh + src.height as i64 - 1) / src.height as i64;
            (0..tiles).map(|i| oy + i * src.height as i64).collect()
        } else {
            vec![oy]
        };
        for &ty in &steps_y {
            for &tx in &steps_x {
                blend_at(&mut out, &src, tx, ty, layer.blend);
            }
        }
    }
    Ok(out)
}

/// Blend `src` onto `dst` with its top-left corner at `(ox, oy)`, clipping to
/// the destination on every edge (negative offsets included).
fn blend_at(dst: &mut RasterImage, src: &RasterImage, ox: i64, oy: i64, mode: BlendMode) {
    let dw = dst.width as i64;
    let dh = dst.height as i64;
    for sy in 0..src.height as i64 {
        let dy = oy + sy;
        if dy < 0 || dy >= dh {
            continue;
        }
        for sx in 0..src.width as i64 {
            let dx = ox + sx;
            if dx < 0 || dx >= dw {
                continue;
            }
            let si = ((sy * src.width as i64 + sx) * 4) as usize;
            let di = ((dy * dw + dx) * 4) as usize;
            let s = [
                src.data[si],
                src.data[si + 1],
                src.data[si + 2],
                src.data[si + 3],
            ];
            let b = [
                dst.data[di],
                dst.data[di + 1],
                dst.data[di + 2],
                dst.data[di + 3],
            ];
            let blended = blend_pixel(b, s, mode);
            dst.data[di..di + 4].copy_from_slice(&blended);
        }
    }
}

#[cfg(test)]
mod tests {
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
        assert_eq!(Gravity::Centre.place((10, 10), (4, 4)), (3, 3));
        assert_eq!(Gravity::NorthWest.place((10, 10), (4, 4)), (0, 0));
        assert_eq!(Gravity::SouthEast.place((10, 10), (4, 4)), (6, 6));
        assert_eq!(Gravity::East.place((10, 10), (4, 4)), (6, 3));
        assert_eq!(Gravity::South.place((10, 10), (4, 4)), (3, 6));
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
    fn wire_spellings_round_trip() {
        assert_eq!(BlendMode::from_wire("dest-in"), Some(BlendMode::DestIn));
        assert_eq!(BlendMode::from_wire("overlay"), None);
        assert_eq!(Gravity::from_wire("center"), Some(Gravity::Centre));
        assert_eq!(Gravity::from_wire("northeast"), Some(Gravity::NorthEast));
        assert_eq!(Gravity::from_wire("entropy"), None);
    }
}

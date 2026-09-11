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

    /// Top-left corner at which an `inner` box sits inside an `outer` box,
    /// for a CROP: the window a `cover` resize keeps, and where a
    /// `composite` overlay lands. sharp's `CalculateCrop` (`src/common.cc`)
    /// centres a crop by rounding the slack UP — `(outer - inner + 1) / 2` —
    /// so an odd number of pixels of slack is biased to the leading edge.
    /// A 20px-wide source cropped to 9px therefore starts at x = 6, not 5.
    pub fn place_crop(self, outer: (u32, u32), inner: (u32, u32)) -> (i64, i64) {
        self.offsets(outer, inner, 1)
    }

    /// Top-left corner at which an `inner` box sits inside an `outer` box,
    /// for a PAD: where a `contain` resize's scaled image sits on its
    /// letterboxed canvas. sharp's `CalculateEmbedPosition` centres by
    /// rounding the slack DOWN — `(outer - inner) / 2` — the opposite bias
    /// to a crop, so the two cannot share one helper. Offsets may be
    /// negative when the image is larger than the box it is placed in.
    pub fn place_pad(self, outer: (u32, u32), inner: (u32, u32)) -> (i64, i64) {
        self.offsets(outer, inner, 0)
    }

    /// The nine placements, with `bias` added to the slack before halving:
    /// `1` for a crop (round up), `0` for a pad (round down). Only the
    /// centred axis of each gravity sees the bias — a flush edge is exact.
    /// Truncating division matches the C++ original for positive slack, and
    /// the pad path (`bias == 0`) is exact for negative slack too, since
    /// `(a - b) / 2` truncates toward zero in both languages.
    fn offsets(self, outer: (u32, u32), inner: (u32, u32), bias: i64) -> (i64, i64) {
        let (ow, oh) = (outer.0 as i64, outer.1 as i64);
        let (iw, ih) = (inner.0 as i64, inner.1 as i64);
        let (mid_x, mid_y) = ((ow - iw + bias) / 2, (oh - ih + bias) / 2);
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
        if layer.image.width == 0 || layer.image.height == 0 {
            return Err(Error::Decode {
                path: "<memory>".into(),
                reason: format!(
                    "composite layer has zero size ({}x{})",
                    layer.image.width, layer.image.height
                ),
            });
        }
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
            (None, None) => layer
                .gravity
                .place_crop((out.width, out.height), (src.width, src.height)),
            (Some(_), None) | (None, Some(_)) => {
                return Err(Error::Decode {
                    path: "<memory>".into(),
                    reason: "composite: a layer must set both left and top, or neither".into(),
                });
            }
        };
        let steps_x = tile_steps(ox, src.width as i64, bw, layer.tile)?;
        let steps_y = tile_steps(oy, src.height as i64, bh, layer.tile)?;
        for &ty in &steps_y {
            for &tx in &steps_x {
                blend_at(&mut out, &src, tx, ty, layer.blend);
            }
        }
    }
    Ok(out)
}

/// A caller-supplied `left`/`top` on a `tile: true` layer is untrusted input
/// (it comes straight off the wire recipe) — this names the arithmetic that
/// would otherwise silently wrap or panic on an offset near `i64::MIN`/`MAX`.
fn offset_overflow(origin: i64, dim: i64, extent: i64) -> Error {
    Error::Decode {
        path: "<memory>".into(),
        reason: format!(
            "composite: tiled layer offset {origin} (dim {dim}, extent {extent}) overflows i64 arithmetic"
        ),
    }
}

/// Tile origins along one axis that replicate a `dim`-sized overlay to cover
/// the WHOLE `[0, extent)` canvas, not just from the placed `origin`
/// forward — matching sharp/libvips, which tile the overlay across the
/// entire base regardless of gravity or offset. Origins are
/// `origin − k·dim` for the smallest `k` that brings the first tile at or
/// before 0, continuing rightward/downward until the far edge is covered.
/// When `tile` is false this is just `[origin]` — no arithmetic, so an
/// out-of-range `origin` alone can't overflow here (`blend_at` clips it).
/// `dim` is always positive — `composite` rejects a zero-size overlay before
/// this runs. Every step uses checked arithmetic and returns an error
/// instead of wrapping or panicking on a hostile `origin` (#3505).
fn tile_steps(origin: i64, dim: i64, extent: i64, tile: bool) -> Result<Vec<i64>> {
    if !tile {
        return Ok(vec![origin]);
    }
    let overflow = || offset_overflow(origin, dim, extent);
    let k = ceil_div(origin, dim).ok_or_else(overflow)?;
    let offset = k.checked_mul(dim).ok_or_else(overflow)?;
    let first = origin.checked_sub(offset).ok_or_else(overflow)?;
    let span = extent.checked_sub(first).ok_or_else(overflow)?;
    let count = ceil_div(span, dim).ok_or_else(overflow)?.max(0);
    (0..count)
        .map(|i| {
            i.checked_mul(dim)
                .and_then(|step| first.checked_add(step))
                .ok_or_else(overflow)
        })
        .collect()
}

/// `ceil(a / b)` for `b > 0`, any sign of `a` (`i64::div_ceil` is unstable).
/// `None` on overflow rather than wrapping or panicking — `a + b - 1` is the
/// one step that can overflow, since `b` (a layer dimension) is always small
/// relative to `i64`, but `a` is a caller-supplied offset that may not be.
fn ceil_div(a: i64, b: i64) -> Option<i64> {
    if a >= 0 {
        a.checked_add(b - 1).map(|sum| sum / b)
    } else {
        Some(a / b)
    }
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
#[path = "raster_composite_tests.rs"]
mod tests;

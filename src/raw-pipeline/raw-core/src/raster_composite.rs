//! Layer compositing for `RasterImage` (#3505).
//!
//! Blending runs in the image's own sRGB-encoded 8-bit space, premultiplied,
//! matching `vips_composite` — NOT in linear light. That choice is deliberate:
//! the package exists so a caller can swap `sharp` for `maple` and get the
//! same bytes out, and libvips composites in the working colourspace.
//!
//! Porter-Duff and libvips separable blending use premultiplied values.
//! Add retains values above 1 until the final output quantization:
//!
//! ```text
//! over:     Co = Cs + Cb·(1 - As)                 Ao = As + Ab·(1 - As)
//! add:      Co = Cs + Cb                          Ao = min(1, As + Ab)
//! dest-in:  Co = Cb·As                            Ao = Ab·As
//! dest-out: Co = Cb·(1 - As)                      Ao = Ab·(1 - As)
//! separable (multiply, screen, darken, lighten), matching libvips:
//!           Co = (1-Ab)·Cs + (1-As)·Cb + As·Ab·B(Cb, Cs)
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

    /// Separable blend function on premultiplied values, matching libvips.
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

fn premultiply(pixel: &[u8]) -> [f32; 4] {
    let alpha = if pixel.len() == 4 {
        to_unit(pixel[3])
    } else {
        1.0
    };
    [
        to_unit(pixel[0]) * alpha,
        to_unit(pixel[1]) * alpha,
        to_unit(pixel[2]) * alpha,
        alpha,
    ]
}

fn unpremultiply(pixel: [f32; 4]) -> [u8; 4] {
    if pixel[3] <= 0.0 {
        return [0, 0, 0, 0];
    }
    [
        to_byte(pixel[0] / pixel[3]),
        to_byte(pixel[1] / pixel[3]),
        to_byte(pixel[2] / pixel[3]),
        to_byte(pixel[3]),
    ]
}

fn blend_pixel(base: [f32; 4], src: &[u8], mode: BlendMode) -> [f32; 4] {
    let ab = base[3];
    let a_s = if src.len() == 4 { to_unit(src[3]) } else { 1.0 };
    let cs = [0, 1, 2].map(|i| to_unit(src[i]));
    let pb = [base[0], base[1], base[2]];
    let ps = cs.map(|c| c * a_s);

    let (ao, po) = match mode {
        BlendMode::Over => (
            a_s + ab * (1.0 - a_s),
            [0, 1, 2].map(|i| ps[i] + pb[i] * (1.0 - a_s)),
        ),
        BlendMode::Add => ((a_s + ab).min(1.0), [0, 1, 2].map(|i| ps[i] + pb[i])),
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
                    .map(|i| (1.0 - ab) * ps[i] + (1.0 - a_s) * pb[i] + a_s * ab * f(pb[i], ps[i])),
            )
        }
    };

    [po[0], po[1], po[2], ao]
}

/// Composite `layers` onto `base`, in order. The result always carries an
/// alpha channel; callers that want RGB out run `remove_alpha` or `flatten`
/// afterwards (the recipe executor does exactly that at encode time).
pub fn composite(base: &RasterImage, layers: &[CompositeLayer<'_>]) -> Result<RasterImage> {
    let placements = layers
        .iter()
        .map(|layer| prepare_layer(base, layer))
        .collect::<Result<Vec<_>>>()?;
    let mut out = base.ensure_alpha(255);
    if layers.is_empty() || out.data.is_empty() {
        return Ok(out);
    }
    const CHUNK_PIXELS: usize = 4096;
    let mut row = vec![[0.0; 4]; (base.width as usize).min(CHUNK_PIXELS)];
    for (y, bytes) in out
        .data
        .chunks_exact_mut(base.width as usize * 4)
        .enumerate()
    {
        for (chunk, bytes) in bytes.chunks_mut(CHUNK_PIXELS * 4).enumerate() {
            let row = &mut row[..bytes.len() / 4];
            for (pixel, accumulated) in bytes.chunks_exact(4).zip(row.iter_mut()) {
                *accumulated = premultiply(pixel);
            }
            for placement in &placements {
                blend_row(row, (chunk * CHUNK_PIXELS) as i64, y as i64, placement);
            }
            for (pixel, accumulated) in bytes.chunks_exact_mut(4).zip(row.iter()) {
                pixel.copy_from_slice(&unpremultiply(*accumulated));
            }
        }
    }
    Ok(out)
}

struct PlacedLayer<'a> {
    image: &'a RasterImage,
    ox: i64,
    oy: i64,
    blend: BlendMode,
    tile: bool,
}

fn prepare_layer<'a>(base: &RasterImage, layer: &CompositeLayer<'a>) -> Result<PlacedLayer<'a>> {
    if layer.image.width == 0 || layer.image.height == 0 {
        return Err(Error::Decode {
            path: "<memory>".into(),
            reason: format!(
                "composite layer has zero size ({}x{})",
                layer.image.width, layer.image.height
            ),
        });
    }
    if layer.image.width > base.width || layer.image.height > base.height {
        return Err(Error::Decode {
            path: "<memory>".into(),
            reason: format!(
                "composite layer {}x{} is larger than the base {}x{}",
                layer.image.width, layer.image.height, base.width, base.height
            ),
        });
    }
    let src = layer.image;
    let (ox, oy) = if layer.tile {
        tiled_placement(base, layer)?
    } else {
        match (layer.left, layer.top) {
            (Some(x), Some(y)) => (x, y),
            (None, None) => layer
                .gravity
                .place_crop((base.width, base.height), (src.width, src.height)),
            _ => return Err(incomplete_offset()),
        }
    };
    Ok(PlacedLayer {
        image: src,
        ox,
        oy,
        blend: layer.blend,
        tile: layer.tile,
    })
}

fn incomplete_offset() -> Error {
    Error::Decode {
        path: "<memory>".into(),
        reason: "composite: a layer must set both left and top, or neither".into(),
    }
}

fn tiled_extent(extent: u32, tile: u32, centred: bool) -> Result<u32> {
    let count = extent.div_ceil(tile) | u32::from(centred);
    count.checked_mul(tile).ok_or_else(|| Error::Decode {
        path: "<memory>".into(),
        reason: "composite: replicated tile extent overflows u32".into(),
    })
}

fn tiled_offset(offset: i64, slack: u32) -> Result<i64> {
    let valid = i32::try_from(offset)
        .ok()
        .filter(|value| *value >= 0)
        .ok_or_else(|| Error::Decode {
            path: "<memory>".into(),
            reason: format!(
                "composite: tiled offset {offset} must be between 0 and {}",
                i32::MAX
            ),
        })?;
    Ok(-i64::from((valid as u32).min(slack)))
}

fn tiled_placement(base: &RasterImage, layer: &CompositeLayer<'_>) -> Result<(i64, i64)> {
    let width = tiled_extent(
        base.width,
        layer.image.width,
        matches!(
            layer.gravity,
            Gravity::Centre | Gravity::North | Gravity::South
        ),
    )?;
    let height = tiled_extent(
        base.height,
        layer.image.height,
        matches!(
            layer.gravity,
            Gravity::Centre | Gravity::East | Gravity::West
        ),
    )?;
    match (layer.left, layer.top) {
        (Some(x), Some(y)) => Ok((
            tiled_offset(x, width - base.width)?,
            tiled_offset(y, height - base.height)?,
        )),
        (None, None) => {
            let (x, y) = layer
                .gravity
                .place_crop((width, height), (base.width, base.height));
            Ok((-x, -y))
        }
        _ => Err(incomplete_offset()),
    }
}

fn blend_row(row: &mut [[f32; 4]], x0: i64, y: i64, layer: &PlacedLayer<'_>) {
    let src = layer.image;
    let sy = if layer.tile {
        (y - layer.oy).rem_euclid(src.height as i64)
    } else {
        let Some(sy) = y
            .checked_sub(layer.oy)
            .filter(|sy| (0..src.height as i64).contains(sy))
        else {
            return;
        };
        sy
    };
    let x1 = x0 + row.len() as i64;
    let (start, end) = if layer.tile {
        (x0, x1)
    } else {
        (
            layer.ox.clamp(x0, x1),
            layer.ox.saturating_add(src.width as i64).clamp(x0, x1),
        )
    };
    for x in start..end {
        let sx = if layer.tile {
            (x - layer.ox).rem_euclid(src.width as i64)
        } else {
            x - layer.ox
        };
        let si = ((sy * src.width as i64 + sx) * src.channels as i64) as usize;
        row[(x - x0) as usize] = blend_pixel(
            row[(x - x0) as usize],
            &src.data[si..si + src.channels as usize],
            layer.blend,
        );
    }
}

#[cfg(test)]
#[path = "raster_composite_tests.rs"]
mod tests;

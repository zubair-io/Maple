//! Dark-channel-prior dehaze (spec § 3.9) with a guided-filter transmission
//! refine and a sky-preservation mask (#272).
//!
//! The frame-global half — atmospheric light, dark channel, transmission and
//! sky mask — is a [`HazeMap`] measured at a fixed proxy resolution
//! (`dehaze_map.rs`, #3287). Recovery is a point operation given that map,
//! so a tile or a native-detail window recovers exactly as the whole frame
//! does once it is told where it sits in the frame.

use rayon::prelude::*;

use crate::image::{ColorSpace, Image};

#[path = "dehaze_map.rs"]
mod map;
pub use map::{proxy_dims, HazeMap, HAZE_PROXY_LONG_EDGE};

#[path = "dehaze_key.rs"]
mod key;
pub use key::haze_key;

/// Existing dark-channel transmission factor, shared with generated WGSL.
pub const TRANSMISSION_OMEGA: f32 = 0.95;
/// Denominator floor for transmission estimates; recovery retains raw airlight.
pub const AIRLIGHT_FLOOR: f32 = 1e-6;
/// Transmission floor guarding the recovery divide on the darkest patches.
const T0: f32 = 0.1;
/// `|dehaze|` below this is identity (and costs nothing).
pub const ENGAGE_EPS: f32 = 1e-3;

/// `true` when `dehaze` would change pixels.
#[inline]
pub fn engaged(dehaze: f32) -> bool {
    dehaze.abs() >= ENGAGE_EPS
}

/// Every haze map one frame's render needs (#3287): the global stage's and,
/// per local-adjustment layer, the map its per-mask dehaze control (#3407)
/// measures from that layer's own scratch copy. Measured once over the
/// whole frame, then handed to every window (tile, native-detail patch) of
/// it, so a window recovers exactly as the whole frame does.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FrameHaze {
    pub global: Option<HazeMap>,
    /// Indexed like the model's `local_adjustments`; `None` for a layer that
    /// does not engage dehaze.
    pub layers: Vec<Option<HazeMap>>,
}

impl FrameHaze {
    /// `true` when this holds every map `model` needs.
    pub fn covers(&self, model: &crate::xmp::AdjustmentModel) -> bool {
        (!engaged(model.dehaze) || self.global.is_some())
            && model
                .local_adjustments
                .iter()
                .enumerate()
                .all(|(i, layer)| {
                    !layer.adjustments.dehaze.is_some_and(engaged)
                        || self.layers.get(i).is_some_and(Option::is_some)
                })
    }

    /// Resident bytes, for host memory accounting.
    pub fn byte_len(&self) -> usize {
        self.global
            .iter()
            .chain(self.layers.iter().flatten())
            .map(HazeMap::byte_len)
            .sum()
    }
}

/// `true` when `model` engages dehaze globally or in any layer.
pub fn any_engaged(model: &crate::xmp::AdjustmentModel) -> bool {
    engaged(model.dehaze)
        || crate::stages::local_adjustments::spatial::any_dehaze_engaged(&model.local_adjustments)
}

/// `smoothstep(edge0, edge1, x)` — cubic Hermite interpolation matching
/// the GLSL builtin. Returns 0 below `edge0`, 1 above `edge1`.
#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Apply dehaze to a whole frame. `dehaze` in [-100, +100]; 0 is identity.
///
/// Positive strengthens haze removal via `J = (I − A) / max(t_eff, t0) + A`;
/// negative adds haze with the forward atmospheric model
/// `J = I·t_haze + A·(1 − t_haze)` — running the recovery divide for a
/// negative value would remove haze and darken the image (#2187).
pub fn apply(img: &mut Image, dehaze: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if !engaged(dehaze) {
        return;
    }
    let map = HazeMap::measure(img);
    let frame = (img.width, img.height);
    recover(img, dehaze, &map, (0, 0), frame);
}

/// Apply dehaze to a window of a frame whose map was measured elsewhere:
/// `img` sits at `origin` inside a `frame` of `(width, height)` pixels, in
/// the same pixel grid (a tile's padding may start outside the frame, so
/// `origin` is signed; outside pixels read the map's edge). Bit-identical to
/// [`apply`] on the whole frame when `map` is that frame's map and the window
/// is the whole frame.
pub fn apply_with_map(
    img: &mut Image,
    dehaze: f32,
    map: &HazeMap,
    origin: (i32, i32),
    frame: (u32, u32),
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if !engaged(dehaze) {
        return;
    }
    recover(img, dehaze, map, origin, frame);
}

/// [`apply`] on a whole frame, recovering with `haze`'s global map when one
/// was measured for it elsewhere.
pub fn apply_whole_frame(img: &mut Image, dehaze: f32, haze: Option<&FrameHaze>) {
    match haze.and_then(|haze| haze.global.as_ref()) {
        Some(map) => {
            let frame = (img.width, img.height);
            apply_with_map(img, dehaze, map, (0, 0), frame)
        }
        None => apply(img, dehaze),
    }
}

fn recover(img: &mut Image, dehaze: f32, map: &HazeMap, origin: (i32, i32), frame: (u32, u32)) {
    let scale = (dehaze / 100.0).clamp(-1.0, 1.0);
    let width = img.width as usize;
    let (pw, ph) = (map.width, map.height);
    let pw_usize = pw as usize;
    img.pixels
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            let (j0, j1, wy) = map::axis_taps(i64::from(origin.1) + y as i64, frame.1, ph);
            let (r0, r1) = (j0 * pw_usize, j1 * pw_usize);
            for (x, p) in row.iter_mut().enumerate() {
                let (i0, i1, wx) = map::axis_taps(i64::from(origin.0) + x as i64, frame.0, pw);
                let taps = [r0 + i0, r0 + i1, r1 + i0, r1 + i1];
                let bilerp = |v: [f32; 4]| {
                    let top = v[0] + wx * (v[1] - v[0]);
                    let bottom = v[2] + wx * (v[3] - v[2]);
                    top + wy * (bottom - top)
                };
                let a = bilerp(taps.map(|k| map.coefficients[k][0]));
                let b = bilerp(taps.map(|k| map.coefficients[k][1]));
                let m = bilerp(taps.map(|k| map.sky[k]));
                let t = a * map::guide(*p, map.airlight) + b;
                if let Some(out) = recover_pixel(*p, t, map.airlight, scale, m) {
                    *p = out;
                }
            }
        });
}

/// One pixel's recovery given its refined transmission `t`, the airlight,
/// `scale = clamp(dehaze / 100, −1, 1)` and its sky-mask weight `mask`.
/// `None` means the pixel is returned bit-identical.
#[inline]
fn recover_pixel(p: [f32; 3], t: f32, a: [f32; 3], scale: f32, mask: f32) -> Option<[f32; 3]> {
    let t = t.clamp(0.0, 1.0);
    let j = if scale >= 0.0 {
        // Keep the window minimum's bound after refinement:
        // t >= 1 - omega * min(I/A) (#4654).
        let point_min = (p[0] / a[0].max(AIRLIGHT_FLOOR))
            .min(p[1] / a[1].max(AIRLIGHT_FLOOR))
            .min(p[2] / a[2].max(AIRLIGHT_FLOOR));
        let point_transmission = (1.0 - TRANSMISSION_OMEGA * point_min).clamp(0.0, 1.0);
        let supported_t = t.max(point_transmission);
        // Avoid cancellation and mask-rounding when recovery is identity.
        if supported_t == 1.0 {
            return None;
        }
        let t_eff = (supported_t + (1.0 - supported_t) * (1.0 - scale)).max(T0);
        [
            (p[0] - a[0]) / t_eff + a[0],
            (p[1] - a[1]) / t_eff + a[1],
            (p[2] - a[2]) / t_eff + a[2],
        ]
    } else {
        // Forward atmospheric model: at zero t_haze=1 and the image is
        // unchanged; at -100, t_haze=t and the veil is strongest.
        let t_haze = 1.0 - (-scale) * (1.0 - t);
        let veil = 1.0 - t_haze;
        [
            p[0] * t_haze + a[0] * veil,
            p[1] * t_haze + a[1] * veil,
            p[2] * t_haze + a[2] * veil,
        ]
    };
    // mask=1 → input, mask=0 → full dehaze.
    let m = mask.clamp(0.0, 1.0);
    let inv_m = 1.0 - m;
    Some([
        inv_m * j[0] + m * p[0],
        inv_m * j[1] + m * p[1],
        inv_m * j[2] + m * p[2],
    ])
}

/// Test seam: recovery with caller-supplied per-pixel transmission and mask.
#[cfg(test)]
fn recover_with_mask(img: &mut Image, dehaze: f32, t: &[f32], a: [f32; 3], mask: &[f32]) {
    let scale = (dehaze / 100.0).clamp(-1.0, 1.0);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        if let Some(out) = recover_pixel(*p, t[i], a, scale, mask[i]) {
            *p = out;
        }
    }
}

#[cfg(test)]
#[path = "dehaze_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "dehaze_transmission_tests.rs"]
mod transmission_tests;

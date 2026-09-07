//! The per-spot pixel work: lift the two patches out of the buffer, build the
//! replacement, and composite it back through the feathered disc.
//!
//! Everything runs in scene-linear Rec.2020 f32 and nothing clips — the one
//! guard is a non-negativity floor on the heal result, because the
//! high-frequency detail it adds is signed and a deep-shadow destination
//! could otherwise be pushed below zero, which downstream Oklab has no
//! meaning for.

use super::geometry::SpotFootprint;
use crate::image::Image;
use crate::stages::blur::gaussian_blur_plane_sigma;
use crate::types::retouch::{RetouchKind, RetouchSpot};

/// One patch of the buffer as three planar channels.
struct Planes {
    r: Vec<f32>,
    g: Vec<f32>,
    b: Vec<f32>,
}

impl Planes {
    fn empty(len: usize) -> Self {
        Self {
            r: vec![0.0; len],
            g: vec![0.0; len],
            b: vec![0.0; len],
        }
    }

    fn channel(&self, c: usize) -> &[f32] {
        match c {
            0 => &self.r,
            1 => &self.g,
            _ => &self.b,
        }
    }

    fn channel_mut(&mut self, c: usize) -> &mut [f32] {
        match c {
            0 => &mut self.r,
            1 => &mut self.g,
            _ => &mut self.b,
        }
    }
}

/// Gather the patch centred on frame pixel `center` into planar buffers.
/// `origin` is the buffer's top-left in frame coordinates.
fn gather(img: &Image, fp: &SpotFootprint, center: (i32, i32), origin: (i32, i32)) -> Planes {
    let (pw, ph) = (fp.width(), fp.height());
    let mut planes = Planes::empty(pw * ph);
    let stride = img.width as usize;
    for row in 0..ph {
        let fy = center.1 + fp.off_y.0 + row as i32 - origin.1;
        let base = fy as usize * stride;
        for col in 0..pw {
            let fx = center.0 + fp.off_x.0 + col as i32 - origin.0;
            let px = img.pixels[base + fx as usize];
            let i = row * pw + col;
            planes.r[i] = px[0];
            planes.g[i] = px[1];
            planes.b[i] = px[2];
        }
    }
    planes
}

/// Coverage of the feathered disc at patch cell `(col, row)`, in `[0, 1]`.
/// Monotonically non-increasing in the distance from the centre: 1 inside the
/// core, a smoothstep across the feather band, 0 beyond the radius.
fn coverage(fp: &SpotFootprint, feather: f32, col: usize, row: usize) -> f32 {
    let dx = (fp.off_x.0 + col as i32) as f32;
    let dy = (fp.off_y.0 + row as i32) as f32;
    let d = (dx * dx + dy * dy).sqrt();
    let core = fp.radius_px * (1.0 - feather);
    if d <= core {
        return 1.0;
    }
    if d >= fp.radius_px {
        return 0.0;
    }
    let band = fp.radius_px - core;
    let t = ((d - core) / band).clamp(0.0, 1.0);
    // 1 − smoothstep(t): full weight at the core edge, zero at the radius.
    1.0 - t * t * (3.0 - 2.0 * t)
}

/// Build the replacement patch for `kind` and composite it into `img`.
pub(super) fn apply_footprint(
    img: &mut Image,
    spot: &RetouchSpot,
    fp: &SpotFootprint,
    origin: (i32, i32),
) {
    let (pw, ph) = (fp.width(), fp.height());
    let src = gather(img, fp, fp.source, origin);
    let dst = gather(img, fp, fp.center, origin);

    // The replacement: a straight copy for Clone, and for Heal the source's
    // high frequencies riding the destination's low frequencies. The additive
    // form is what makes heal preserve the destination's local mean — the
    // detail term `src - src_low` integrates to ~0 over the blur support.
    let repl = match spot.kind {
        RetouchKind::Clone => src,
        RetouchKind::Heal => {
            let mut out = Planes::empty(pw * ph);
            for c in 0..3 {
                let src_c = src.channel(c);
                let dst_c = dst.channel(c);
                let src_low = gaussian_blur_plane_sigma(src_c, pw, ph, fp.sigma);
                let dst_low = gaussian_blur_plane_sigma(dst_c, pw, ph, fp.sigma);
                let out_c = out.channel_mut(c);
                for i in 0..out_c.len() {
                    out_c[i] = (dst_low[i] + (src_c[i] - src_low[i])).max(0.0);
                }
            }
            out
        }
    };

    let feather = spot.clamped_feather();
    let opacity = spot.clamped_opacity();
    let stride = img.width as usize;
    for row in 0..ph {
        let fy = fp.center.1 + fp.off_y.0 + row as i32 - origin.1;
        let base = fy as usize * stride;
        for col in 0..pw {
            let w = coverage(fp, feather, col, row) * opacity;
            if w <= 0.0 {
                continue;
            }
            let fx = fp.center.0 + fp.off_x.0 + col as i32 - origin.0;
            let i = row * pw + col;
            let px = &mut img.pixels[base + fx as usize];
            for c in 0..3 {
                let target = repl.channel(c)[i];
                px[c] += (target - px[c]) * w;
            }
        }
    }
}

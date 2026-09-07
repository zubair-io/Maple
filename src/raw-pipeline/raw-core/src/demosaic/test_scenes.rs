//! Synthetic Bayer scenes shared by the #3413 kernel tests (VNG4, LMMSE,
//! dual). Test-only.
//!
//! Everything here builds a mosaic the way `sensor_linearize` does — exactly
//! one populated channel per pixel, the one the CFA says that site samples —
//! so a kernel under test sees the same shape it sees in production.

use crate::image::{CfaPattern, ColorSpace, Image};

pub(super) const PATTERNS: [CfaPattern; 4] = [
    CfaPattern::Rggb,
    CfaPattern::Bggr,
    CfaPattern::Grbg,
    CfaPattern::Gbrg,
];

/// Build a Bayer mosaic whose scene value at `(x, y)` for channel `c` is
/// `scene(x, y, c)`; only the CFA-selected channel is populated.
pub(super) fn mosaic_from<F>(w: u32, h: u32, cfa: CfaPattern, scene: F) -> Image
where
    F: Fn(u32, u32, usize) -> f32,
{
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            img.pixels[(y * w + x) as usize][c] = scene(x, y, c);
        }
    }
    img
}

/// A flat field: every channel constant at its own level.
pub(super) fn uniform(w: u32, h: u32, cfa: CfaPattern, rgb: [f32; 3]) -> Image {
    mosaic_from(w, h, cfa, |_, _, c| rgb[c])
}

/// Grey ramp: every channel carries the same linear function of `x` and
/// `y`, so a correct reconstruction is exact everywhere.
pub(super) fn grey_ramp(w: u32, h: u32, cfa: CfaPattern) -> Image {
    mosaic_from(w, h, cfa, |x, y, _| {
        0.05 + 0.004 * x as f32 + 0.003 * y as f32
    })
}

/// A hard grey step edge. `vertical` puts the edge at column `split` (the
/// scene varies along x); otherwise it is at row `split`.
pub(super) fn step_edge(w: u32, h: u32, cfa: CfaPattern, vertical: bool, split: u32) -> Image {
    mosaic_from(w, h, cfa, |x, y, _| {
        let across = if vertical { x } else { y };
        if across < split {
            0.15
        } else {
            0.85
        }
    })
}

/// Deterministic value-noise in `[-1, 1]`, seeded by position and channel.
///
/// A hash rather than an RNG so every test observes the same field on every
/// run and on every platform — a demosaic noise claim that moves run to run
/// is not a gate.
pub(super) fn noise_at(x: u32, y: u32, c: usize, seed: u32) -> f32 {
    let mut h = x.wrapping_mul(0x9E37_79B9)
        ^ y.wrapping_mul(0x85EB_CA6B)
        ^ (c as u32).wrapping_mul(0xC2B2_AE35)
        ^ seed.wrapping_mul(0x27D4_EB2F);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2545_F491);
    h ^= h >> 13;
    (h as f32 / u32::MAX as f32) * 2.0 - 1.0
}

/// A flat grey patch buried in noise — the high-ISO sky the detail-first
/// kernels turn into maze patterning and false colour. `sigma` is the
/// per-sample amplitude in scene-linear units.
pub(super) fn noisy_flat(w: u32, h: u32, cfa: CfaPattern, level: f32, sigma: f32) -> Image {
    mosaic_from(w, h, cfa, |x, y, c| {
        (level + sigma * noise_at(x, y, c, 0x5EED)).max(0.0)
    })
}

/// Edge of the block the false-colour metric averages over.
const FALSE_COLOUR_BLOCK: u32 = 8;

/// False-colour energy of a reconstruction on a grey scene: the mean over
/// [`FALSE_COLOUR_BLOCK`]-square blocks of `|mean(R − G)| + |mean(B − G)|`.
///
/// On a grey scene the true colour difference is zero everywhere, so
/// whatever this number is, the kernel invented it.
///
/// The block average is the whole point of the metric and not a
/// convenience. A *per-pixel* `|R − G|` on a noisy frame is dominated by the
/// noise on the site's own native sample — an R site's red is the sensor
/// reading, complete with its read noise, whichever kernel ran — so it comes
/// out near-identical for every kernel and measures nothing about the
/// reconstruction. False colour as a viewer experiences it is the
/// *low-frequency* part: coloured blotches tens of pixels across. Averaging
/// over a block suppresses independent per-site noise by the square root of
/// the block's sample count while leaving spatially-correlated chroma error
/// — which is exactly what a kernel that latched onto noise produces —
/// untouched.
pub(super) fn false_colour_energy(img: &Image, margin: u32) -> f64 {
    let w = img.width;
    let block = FALSE_COLOUR_BLOCK;
    let mut total = 0.0f64;
    let mut blocks = 0u64;
    let mut y = margin;
    while y + block <= img.height - margin {
        let mut x = margin;
        while x + block <= w - margin {
            let (mut rg, mut bg) = (0.0f64, 0.0f64);
            for dy in 0..block {
                for dx in 0..block {
                    let p = img.pixels[((y + dy) * w + x + dx) as usize];
                    rg += (p[0] - p[1]) as f64;
                    bg += (p[2] - p[1]) as f64;
                }
            }
            let n = (block * block) as f64;
            total += (rg / n).abs() + (bg / n).abs();
            blocks += 1;
            x += block;
        }
        y += block;
    }
    total / blocks as f64
}

/// RMS error of the reconstructed green at the sites where green was NOT
/// sampled, against a known flat truth.
///
/// This is the reconstruction's own contribution with the sensor's native
/// green samples excluded — at a green site every kernel writes the sample
/// back verbatim, so including those sites would add an identical constant
/// to every kernel's score and hide the difference under it.
pub(super) fn interpolated_green_rms(img: &Image, cfa: CfaPattern, truth: f32, margin: u32) -> f64 {
    let w = img.width;
    let mut total = 0.0f64;
    let mut n = 0u64;
    for y in margin..img.height - margin {
        for x in margin..w - margin {
            if cfa.color_at(x, y) == 1 {
                continue;
            }
            let d = (img.pixels[(y * w + x) as usize][1] - truth) as f64;
            total += d * d;
            n += 1;
        }
    }
    (total / n as f64).sqrt()
}

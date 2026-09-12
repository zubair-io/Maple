//! The recipe's colour ops (#3503 Task D6): `greyscale`, `gamma`, `linear`,
//! `negate`, `normalise`, `modulate`, `tint`, `toColourspace`. Split out of
//! `raster_recipe_exec.rs` so that file stays focused on decode/resize/
//! composite/encode — same file-per-lane split the geometry ops use
//! (`raster_recipe_geometry.rs`).
//!
//! Every `RasterImage` op these wrap (`greyscale`, `gamma`, `linear`, …)
//! returns `Self` rather than `Result` — none of them can fail internally —
//! so a malformed or hostile recipe's out-of-range values must be caught
//! HERE, before the op ever runs, or not at all. `gamma`/`gammaOut`'s own
//! `[1.0, 3.0]` sharp-side range is validated in the TS builder instead (see
//! `builder-colour.ts`): the wire `exponent` field is not the user-facing
//! `gamma`/`gammaOut` value but `1/gamma` for the pre-resize instance, so a
//! `[1.0, 3.0]` bound on the wire field itself would reject nearly every
//! legitimate call (`1/2.2 ≈ 0.4545`). What IS checked here is that the wire
//! exponent is finite, which protects a hand-crafted recipe sent straight
//! over the FFI rather than through the builder.

use crate::raster::RasterImage;
use crate::raster_recipe::{bad, Op, Recipe};
use crate::view::encode::TargetPrimaries;

/// The wire spelling accepted by `toColourspace`. Only the two primaries
/// this crate can tag a file with — anything else (including libvips
/// interpretation names like `b-w`/`cmyk`/`lab`, which sharp itself accepts
/// for other colourspace conversions) is rejected by name.
pub(crate) fn primaries_from_wire(s: &str) -> crate::error::Result<TargetPrimaries> {
    match s {
        "srgb" => Ok(TargetPrimaries::Srgb),
        "display-p3" | "p3" => Ok(TargetPrimaries::P3),
        other => Err(bad(format!(
            "unsupported colourspace '{other}' (expected srgb, display-p3 or p3)"
        ))),
    }
}

/// The primaries the encoder tags with: the last `toColourspace` in the op
/// list, or sRGB.
pub(crate) fn output_primaries(recipe: &Recipe) -> crate::error::Result<TargetPrimaries> {
    recipe
        .ops
        .iter()
        .rev()
        .find_map(|op| match op {
            Op::ToColourspace { space } => Some(primaries_from_wire(space)),
            _ => None,
        })
        .unwrap_or(Ok(TargetPrimaries::Srgb))
}

fn require_finite(name: &str, v: f64) -> crate::error::Result<()> {
    if v.is_finite() {
        Ok(())
    } else {
        Err(bad(format!("{name} must be finite, got {v}")))
    }
}

/// Apply one of the eight colour ops. Called from
/// `raster_recipe_exec::apply_op` for every `Op` variant this module owns.
///
/// `current_primaries` is the primaries the image is ACTUALLY in right now
/// — tracked by the caller across the whole op list, starting at sRGB (the
/// decoder's output space) and updated on every `ToColourspace` this
/// function returns. Every op but `ToColourspace` passes it straight
/// through unchanged; `ToColourspace` uses it as `from` (not a hardcoded
/// sRGB) so a second `toColourspace` call rotates from where the pixels
/// actually are, not from where they started — without this, `[toP3,
/// toSrgb]` would apply the sRGB->P3 matrix twice instead of rotating back.
pub(crate) fn apply_colour_op(
    image: RasterImage,
    current_primaries: TargetPrimaries,
    op: &Op,
) -> crate::error::Result<(RasterImage, TargetPrimaries)> {
    match op {
        Op::Greyscale {} => Ok((image.greyscale(), current_primaries)),
        Op::Gamma { exponent } => {
            require_finite("gamma exponent", *exponent)?;
            Ok((image.gamma(*exponent), current_primaries))
        }
        Op::Linear { a, b } => {
            for (i, v) in a.iter().enumerate() {
                require_finite(&format!("linear a[{i}]"), *v)?;
            }
            for (i, v) in b.iter().enumerate() {
                require_finite(&format!("linear b[{i}]"), *v)?;
            }
            Ok((image.linear(*a, *b), current_primaries))
        }
        Op::Negate { alpha } => Ok((image.negate(*alpha), current_primaries)),
        Op::Normalise { lower, upper } => {
            require_finite("normalise lower", *lower)?;
            require_finite("normalise upper", *upper)?;
            if !(0.0..=100.0).contains(lower) || !(0.0..=100.0).contains(upper) || lower >= upper {
                return Err(bad(format!(
                    "normalise: expected 0 <= lower < upper <= 100, got lower={lower}, upper={upper}"
                )));
            }
            Ok((image.normalise(*lower, *upper), current_primaries))
        }
        Op::Modulate {
            brightness,
            saturation,
            hue,
            lightness,
        } => {
            require_finite("modulate brightness", *brightness)?;
            require_finite("modulate saturation", *saturation)?;
            require_finite("modulate hue", *hue)?;
            require_finite("modulate lightness", *lightness)?;
            if *brightness < 0.0 {
                return Err(bad(format!(
                    "modulate brightness must be >= 0, got {brightness}"
                )));
            }
            if *saturation < 0.0 {
                return Err(bad(format!(
                    "modulate saturation must be >= 0, got {saturation}"
                )));
            }
            Ok((
                image.modulate(*brightness, *saturation, *hue, *lightness),
                current_primaries,
            ))
        }
        Op::Tint { rgb } => Ok((image.tint(*rgb), current_primaries)),
        Op::ToColourspace { space } => {
            let to = primaries_from_wire(space)?;
            Ok((image.to_colourspace(current_primaries, to), to))
        }
        other => unreachable!("apply_colour_op called with a non-colour op: {other:?}"),
    }
}

#[cfg(test)]
#[path = "raster_recipe_colour_tests.rs"]
mod tests;

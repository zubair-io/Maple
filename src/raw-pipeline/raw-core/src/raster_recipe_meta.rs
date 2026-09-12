//! The recipe's `metadata` block (#3507): what to keep from the input's own
//! EXIF/ICC/XMP, what to override with caller-supplied blocks, and what EXIF
//! Orientation value to (over)write.
//!
//! Kept apart from `raster_recipe.rs`'s other wire types and from
//! `raster_recipe_exec.rs`'s execution: this branch has not yet received the
//! PR-C/D/E per-family executor split, so isolating the metadata
//! parsing/resolution here (rather than folding it into either of those
//! files) keeps that later rebase from having to untangle it back out.
//!
//! Absent `metadata` block = strip everything, which is sharp's own default
//! (`keepMetadata()`/`withMetadata()` are both opt-in).

use crate::error::Result;
use crate::raster_meta::RasterSidecars;
use crate::raster_recipe::AuxRef;
use serde::Deserialize;

/// What to do with the input's metadata.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeMetadata {
    /// Copy EXIF, ICC and XMP from the input (sharp's `keepMetadata`).
    #[serde(default)]
    pub keep: bool,
    /// Write this EXIF Orientation value, creating an EXIF block if the
    /// resolved input carries none.
    #[serde(default)]
    pub orientation: Option<u16>,
    /// Pixels-per-inch to tag the output with. `None` leaves each output
    /// container's own default density tagging (or lack of one) alone.
    #[serde(default)]
    pub density: Option<f64>,
    /// Caller-supplied EXIF block, in the `aux` buffer. Wins over `keep`.
    #[serde(default)]
    pub exif: Option<AuxRef>,
    /// Caller-supplied ICC profile, in the `aux` buffer. Wins over `keep`
    /// and over `iccName`.
    #[serde(default)]
    pub icc: Option<AuxRef>,
    /// A named built-in profile ("srgb" or "p3") instead of caller-supplied
    /// bytes (#3507 fix-round-1, item 2 — the package's `withIccProfile('srgb'
    /// | 'p3')`). Resolved via [`crate::icc::profile_for`] rather than an
    /// `aux` reference, so the package never has to ship a copy of these
    /// bytes itself. Ignored when `icc` is also set.
    #[serde(default)]
    pub icc_name: Option<String>,
    /// Caller-supplied XMP packet, in the `aux` buffer. Wins over `keep`.
    #[serde(default)]
    pub xmp: Option<AuxRef>,
}

/// Metadata blocks resolved and ready to hand to an encoder (#3507; see
/// `raster_recipe_encode`'s per-format `encode_*_with_metadata` functions,
/// and `raster_recipe_exec::encode`'s capability check ahead of them).
///
/// Every field is a plain "embed exactly this, or nothing" instruction now
/// (fix-round-1, item 2) — `icc: None` embeds NO profile at all, matching
/// sharp's own default (measured: `sharp(png).jpeg().toBuffer()` →
/// `metadata().hasProfile === false`). There is no more "leave the
/// container's own default tagging alone" special case: that used to mean
/// silently embedding a 6684-byte sRGB profile even with no `metadata` block
/// at all, which sharp does not do.
#[derive(Clone, Debug, Default)]
pub struct ResolvedMetadata {
    pub exif: Option<Vec<u8>>,
    pub icc: Option<Vec<u8>>,
    pub xmp: Option<Vec<u8>>,
    pub density: Option<f64>,
    /// Whether `exif` is a block the caller named — an explicit
    /// `metadata.exif` (`withExif`) — rather than one `keep` swept up out
    /// of the input, or one synthesised to carry `metadata.orientation`.
    /// See [`ResolvedMetadata::icc_requested`] for why the distinction
    /// exists.
    pub exif_requested: bool,
    /// Whether `icc` is a profile the caller named — an explicit
    /// `metadata.icc` or `metadata.iccName` (`withIccProfile`).
    ///
    /// `keep`'s own sweep is not a request (#3507 final fix wave, item 6).
    /// `keepMetadata()`/`withMetadata()` set `keep` for every block at
    /// once, so holding a target container to blocks the caller never
    /// mentioned turned `withMetadata({orientation:5})` on a WebP source
    /// into `"WebP cannot embed XMP (requested via metadata.xmp / keep)"` —
    /// an error naming a field the caller never touched, for a call sharp
    /// completes. A field `keep` swept up that the container cannot carry
    /// is dropped silently instead, which is what sharp does; only a block
    /// named by `withExif`/`withIccProfile`/`withXmp`/`withMetadata
    /// ({density})` is an error worth raising.
    pub icc_requested: bool,
    /// Whether `xmp` is a packet the caller named — an explicit
    /// `metadata.xmp` (`withXmp`) — rather than one `keep` swept up.
    pub xmp_requested: bool,
}

/// sRGB — the profile `keep: true` adds when the input carries none, mirroring
/// sharp's `withMetadata()` (measured: `sharp(pngWithNoIcc).withMetadata()
/// .png().toBuffer()` → `metadata().hasProfile === true`, a ~430-byte lcms
/// sRGB profile — sharp's default `.jpeg()`/`.png()`/etc with no
/// `withMetadata()` at all embeds nothing, per the same measurement).
///
/// Hardcodes sRGB rather than the recipe's actual output primaries because
/// this schema has no `toColourspace`/output-primaries concept yet (PR-D).
/// Once it does, this default should follow the output's real primaries
/// instead — the same call-site note already exists on the PR-F branch for
/// the equivalent hardcoded-sRGB decision there; this is that same TODO.
fn default_icc() -> Vec<u8> {
    crate::icc::profile_for(crate::view::encode::TargetPrimaries::Srgb)
}

/// Resolve `metadata.iccName` ("srgb"/"p3") to the package's own built-in
/// profile bytes — see `RecipeMetadata::icc_name`'s doc for why this is a
/// named lookup rather than another `aux` reference.
fn icc_bytes_for_name(name: &str) -> Result<Vec<u8>> {
    match name {
        "srgb" => Ok(crate::icc::profile_for(
            crate::view::encode::TargetPrimaries::Srgb,
        )),
        "p3" => Ok(crate::icc::profile_for(
            crate::view::encode::TargetPrimaries::P3,
        )),
        other => Err(crate::error::Error::Decode {
            path: "<recipe>".into(),
            reason: format!(
                "metadata.iccName '{other}' is not a known profile name (expected 'srgb' or 'p3')"
            ),
        }),
    }
}

/// Assemble the metadata blocks an encoder should embed. Caller-supplied
/// blocks (`aux`-referenced) win over `keep`; an explicit `orientation`
/// rewrites whichever EXIF block survives that resolution, creating a
/// minimal one when there is none to rewrite.
///
/// `auto_oriented` is `true` when the recipe ran `Op::AutoOrient` — the
/// pixels are already rotated to match whatever Orientation the input
/// declared, so a resolved EXIF block that still says otherwise would tell a
/// second reader to rotate again. Measured against sharp:
/// `sharp(oriented6).rotate().withMetadata().jpeg()` → `metadata().orientation
/// === 1` (the EXIF block survives — `hasExif` stays `true` — just
/// neutralised, not `undefined`; that only happens with no EXIF block at
/// all). An explicit `metadata.orientation` still wins over that
/// neutralisation exactly as it would without autoOrient — also measured:
/// `sharp(oriented6).rotate().withMetadata({orientation:6}).jpeg()` →
/// `metadata().orientation === 6`, sharp does NOT force 1 over an explicit
/// value. Neutralise-then-override (rather than "regardless of an explicit
/// value", read overly literally) is what matches sharp here.
pub fn resolve_metadata(
    metadata: &RecipeMetadata,
    input: &[u8],
    aux: &[u8],
    auto_oriented: bool,
) -> Result<ResolvedMetadata> {
    let kept = if metadata.keep {
        crate::raster_meta::read_sidecars(input)
    } else {
        RasterSidecars::default()
    };
    let supplied = |field: &str, reference: Option<AuxRef>| -> Result<Option<Vec<u8>>> {
        reference
            .map(|r| {
                r.slice(aux).map(|s| s.to_vec()).map_err(|e| match e {
                    crate::error::Error::Decode { reason, .. } => crate::error::Error::Decode {
                        path: "<recipe>".into(),
                        reason: format!("metadata.{field} {reason}"),
                    },
                    other => other,
                })
            })
            .transpose()
    };
    // A caller-supplied block is canonicalised the same way a container's
    // own is (#3507 final fix wave, item 3): `withExif(sharpMeta.exif)` is
    // the obvious thing to write, and sharp hands out an `Exif\0\0`-
    // introduced block for three of the five containers. Every encoder
    // below wants the bare TIFF header.
    let supplied_exif = supplied("exif", metadata.exif)?
        .map(|block| crate::raster_meta::canonical_exif(&block).0.to_vec());
    let exif_requested = supplied_exif.is_some();
    let exif_base = supplied_exif.or(kept.exif);
    let neutralised = if auto_oriented {
        exif_base
            .as_deref()
            .map(|block| crate::raster_meta::set_exif_orientation(block, 1))
    } else {
        exif_base
    };
    let oriented = match metadata.orientation {
        Some(orientation) => Some(crate::raster_meta::set_exif_orientation(
            neutralised.as_deref().unwrap_or(&[]),
            orientation,
        )),
        None => neutralised,
    };
    // A density has to land in the EXIF block too, not only in the
    // container's own JFIF/`pHYs` field, because libvips prefers the EXIF
    // resolution when reading one back (#3507 final fix wave, item 7).
    // Measured before the fix: `keepMetadata().withMetadata({density:300})`
    // on a JPEG whose kept EXIF said 96 dpi wrote a 300 dpi JFIF segment,
    // and sharp read 96. Only an EXIF block that already exists is
    // rewritten — with no block to carry, the container's own field is the
    // only place the density needs to be, and both Maple and sharp read
    // it back correctly from there.
    let exif = match (metadata.density, oriented) {
        (Some(dpi), Some(block)) => Some(crate::raster_meta::set_exif_resolution(&block, dpi)),
        (_, block) => block,
    };
    // `keep` mirrors sharp's `withMetadata()`: an ICC profile already
    // present is copied through as-is, and one that's absent gets a default
    // sRGB profile added (see `default_icc`'s doc) — `keep: false` with no
    // supplied override means no ICC at all, matching sharp's own default.
    let supplied_icc = match supplied("icc", metadata.icc)? {
        Some(bytes) => Some(bytes),
        None => match metadata.icc_name.as_deref() {
            Some(name) => Some(icc_bytes_for_name(name)?),
            None => None,
        },
    };
    // Only an ICC the caller named counts as requested: an explicit
    // override or a named built-in profile. Neither `keep`'s sweep of the
    // input's own profile nor the default sRGB fill below is something to
    // hold a can't-write-ICC format (AVIF, #3580) to — see the field's doc.
    let icc_requested = supplied_icc.is_some();
    let icc = supplied_icc.or_else(|| kept.icc.clone().or_else(|| metadata.keep.then(default_icc)));
    let supplied_xmp = supplied("xmp", metadata.xmp)?;
    let xmp_requested = supplied_xmp.is_some();
    let xmp = supplied_xmp.or(kept.xmp);
    Ok(ResolvedMetadata {
        exif,
        icc,
        xmp,
        density: metadata.density,
        exif_requested,
        icc_requested,
        xmp_requested,
    })
}

#[cfg(test)]
#[path = "raster_recipe_meta_tests.rs"]
mod tests;

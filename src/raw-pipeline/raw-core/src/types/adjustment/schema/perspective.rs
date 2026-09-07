//! Manual-geometry schema entries (#3410) — Adobe's `crs:Perspective*` keys,
//! split out of `schema/mod.rs` to keep that file under the 570-line headroom
//! budget (CONTRIBUTING.md). `ADJUSTMENT_SCHEMA` lists these consts in place,
//! so schema order still matches struct order.
//!
//! Seven scalars composing into ONE homography (`stages::perspective`),
//! applied between EXIF orientation and the user crop. Ranges and defaults
//! are Adobe's, so a Lightroom sidecar's values load without rescaling; the
//! normalized coefficients each unit maps to are pinned by the constants in
//! `stages::perspective::matrix`.

use super::{FieldKind, FieldSpec};

/// A manual-geometry slider: `F32`, range −100..100, default 0. Five of the
/// seven share that shape exactly; `rotate` and `scale` spell their own out.
const fn geometry_field(name: &'static str, doc: &'static str) -> FieldSpec {
    FieldSpec {
        name,
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc,
    }
}

pub(super) const PERSPECTIVE_VERTICAL: FieldSpec = geometry_field(
    "perspective_vertical",
    "Vertical keystone correction (#3410, `crs:PerspectiveVertical`). Projective coefficient about the image centre: positive converges the bottom edge (the correction for a camera tilted up at a building). 0 (default) contributes an identity row to the homography.",
);

pub(super) const PERSPECTIVE_HORIZONTAL: FieldSpec = geometry_field(
    "perspective_horizontal",
    "Horizontal keystone correction (#3410, `crs:PerspectiveHorizontal`). Projective coefficient about the image centre: positive converges the right edge. 0 (default) is identity.",
);

pub(super) const PERSPECTIVE_ROTATE: FieldSpec = FieldSpec {
    name: "perspective_rotate",
    kind: FieldKind::F32,
    range: (-10.0, 10.0),
    default_f32: 0.0,
    enum_name: "",
    doc: "Geometry rotation in degrees, positive = clockwise (#3410, `crs:PerspectiveRotate`). Adobe's ±10° fine level, independent of `crop.angle`'s ±45° straighten: this one rotates INSIDE the frame the crop then samples, so the two compose rather than replace one another. 0 (default) is identity.",
};

pub(super) const PERSPECTIVE_SCALE: FieldSpec = FieldSpec {
    name: "perspective_scale",
    kind: FieldKind::F32,
    range: (50.0, 150.0),
    default_f32: 100.0,
    enum_name: "",
    doc: "Uniform scale about the image centre, in percent (#3410, `crs:PerspectiveScale`). Below 100 shrinks the frame's content inward (exposing the transparent surround a keystone leaves behind); above 100 magnifies it to push that surround off-frame. 100 (default) is identity.",
};

pub(super) const PERSPECTIVE_ASPECT: FieldSpec = geometry_field(
    "perspective_aspect",
    "Aspect stretch (#3410, `crs:PerspectiveAspect`). Positive stretches horizontally and compresses vertically by the reciprocal factor, so frame area is preserved; negative does the opposite. 0 (default) is identity.",
);

pub(super) const PERSPECTIVE_X: FieldSpec = geometry_field(
    "perspective_x",
    "Horizontal offset of the transformed frame (#3410, `crs:PerspectiveX`). ±100 shifts by one half-extent — half the frame width. 0 (default) is identity.",
);

pub(super) const PERSPECTIVE_Y: FieldSpec = geometry_field(
    "perspective_y",
    "Vertical offset of the transformed frame (#3410, `crs:PerspectiveY`). ±100 shifts by one half-extent — half the frame height. 0 (default) is identity.",
);

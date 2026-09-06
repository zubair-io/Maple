use super::{FieldKind, FieldSpec};

const fn field(
    name: &'static str,
    range: (f32, f32),
    default_f32: f32,
    doc: &'static str,
) -> FieldSpec {
    FieldSpec {
        name,
        kind: FieldKind::F32,
        range,
        default_f32,
        enum_name: "",
        doc,
    }
}

pub const PERSPECTIVE_H: FieldSpec = field(
    "geo_perspective_h",
    (-0.4, 0.4),
    0.0,
    "Horizontal perspective in display framing. XMP key `papp:GeoPerspectiveH`.",
);
pub const PERSPECTIVE_V: FieldSpec = field(
    "geo_perspective_v",
    (-0.4, 0.4),
    0.0,
    "Vertical perspective in display framing. XMP key `papp:GeoPerspectiveV`.",
);
pub const ROTATION: FieldSpec = field(
    "geo_rotation",
    (-180.0, 180.0),
    0.0,
    "Clockwise rotation in degrees. XMP key `papp:GeoRotation`.",
);
pub const ASPECT: FieldSpec = field(
    "geo_aspect",
    (0.5, 2.0),
    1.0,
    "Area-preserving horizontal/vertical aspect ratio. XMP key `papp:GeoAspect`.",
);
pub const SCALE: FieldSpec = field(
    "geo_scale",
    (0.25, 4.0),
    1.0,
    "Centered uniform image scale. XMP key `papp:GeoScale`.",
);

//! Scene-linear Rec.2020 D65 RGB values for the 24 X-Rite ColorChecker
//! patches. Approximations of the published sRGB swatches converted to
//! linear-light Rec.2020. These values are stable references for the
//! SyntheticColorChart writer.

/// 6 columns × 4 rows. Row 0 = "natural" colors, row 3 = neutrals.
pub const COLORCHECKER_REC2020: [[[f32; 3]; 6]; 4] = [
    // Row 0 — natural / skin / sky / foliage / blue flower / bluish green
    [
        [0.156, 0.092, 0.063], // dark skin
        [0.456, 0.297, 0.217], // light skin
        [0.180, 0.234, 0.351], // blue sky
        [0.116, 0.183, 0.073], // foliage
        [0.246, 0.224, 0.401], // blue flower
        [0.323, 0.501, 0.461], // bluish green
    ],
    // Row 1 — orange / purple-blue / red / purple / yellow-green / orange-yellow
    [
        [0.595, 0.298, 0.075], // orange
        [0.107, 0.186, 0.412], // purplish blue
        [0.376, 0.115, 0.149], // moderate red
        [0.094, 0.062, 0.143], // purple
        [0.392, 0.481, 0.108], // yellow green
        [0.694, 0.474, 0.067], // orange yellow
    ],
    // Row 2 — primary blue / green / red / yellow / magenta / cyan
    [
        [0.046, 0.087, 0.396], // blue
        [0.133, 0.321, 0.114], // green
        [0.482, 0.058, 0.062], // red
        [0.812, 0.730, 0.090], // yellow
        [0.444, 0.123, 0.327], // magenta
        [0.055, 0.310, 0.484], // cyan
    ],
    // Row 3 — neutrals (white → black) at descending Y values.
    [
        [0.949, 0.949, 0.949], // white  (~95% reflectance)
        [0.502, 0.502, 0.502], // neutral 8
        [0.302, 0.302, 0.302], // neutral 6.5
        [0.181, 0.181, 0.181], // neutral 5
        [0.103, 0.103, 0.103], // neutral 3.5
        [0.052, 0.052, 0.052], // black
    ],
];

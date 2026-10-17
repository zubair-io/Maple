// Shared resident row layout for BM3D matching, filtering and aggregation (#4629).
const PATCH: u32 = BM3D_BLOCK * BM3D_BLOCK;
const GROUP_VALUES: u32 = PATCH * BM3D_GROUP_MAX;
struct Matches {
    count: u32,
    sigma_y: f32,
    sigma_c1: f32,
    sigma_c2: f32,
    positions: array<vec2<u32>, BM3D_GROUP_MAX>,
};
struct Filtered {
    weight: f32,
    pad: array<u32, 3>,
    weighted_deltas: array<f32, GROUP_VALUES>,
};

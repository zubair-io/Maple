struct Params { width: u32, count: u32, first_y: u32, columns: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> matches: array<Matches>;
@group(0) @binding(2) var<storage, read> filtered: array<Filtered>;
@group(0) @binding(3) var<storage, read_write> numerator: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> denominator: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let index = id.y * groups.x * 64u + id.x;
    if index >= params.count { return; }
    let p = vec2<u32>(index % params.width, params.first_y + index / params.width);
    let pixel_index = p.y * params.width + p.x;
    var num = numerator[pixel_index].xyz;
    var den = denominator[pixel_index].xyz;
    // A patch reaching x must come from a reference in [x - search - 7, x + search].
    // Include the clamped final reference even when it is not stride-aligned.
    let first = u32(max(0, i32(p.x) - i32(BM3D_SEARCH_HALF + BM3D_BLOCK - 1u))) / BM3D_STRIDE;
    let last = min(params.columns, (p.x + BM3D_SEARCH_HALF) / BM3D_STRIDE + 2u);
    for (var col = first; col < last; col++) {
        let count = matches[col].count;
        let base = col * 3u;
        let weights = vec3<f32>(filtered[base].weight, filtered[base + 1u].weight, filtered[base + 2u].weight);
        for (var k = 0u; k < count; k++) {
            let origin = matches[col].positions[k];
            if any(p < origin) || any(p >= origin + vec2<u32>(BM3D_BLOCK)) { continue; }
            let offset = p - origin;
            let pixel = k * PATCH + offset.y * BM3D_BLOCK + offset.x;
            let delta = vec3<f32>(filtered[base].weighted_deltas[pixel], filtered[base + 1u].weighted_deltas[pixel], filtered[base + 2u].weighted_deltas[pixel]);
            num += delta;
            den += weights;
        }
    }
    numerator[pixel_index] = vec4<f32>(num, 0.0);
    denominator[pixel_index] = vec4<f32>(den, 0.0);
}

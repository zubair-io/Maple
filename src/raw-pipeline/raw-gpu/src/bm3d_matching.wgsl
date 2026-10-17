const PATCH: u32 = BM3D_BLOCK * BM3D_BLOCK;
const SEARCH_EDGE: u32 = 2u * BM3D_SEARCH_HALF + 1u;
const CANDIDATES: u32 = SEARCH_EDGE * SEARCH_EDGE;
struct Params { width: u32, height: u32, reference_y: u32, columns: u32 };
struct Matches { count: u32, pad: u32, positions: array<vec2<u32>, BM3D_GROUP_MAX> };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> luma: array<f32>;
@group(0) @binding(2) var<storage, read> threshold: array<f32>;
@group(0) @binding(3) var<storage, read_write> output: array<Matches>;
var<workgroup> reference_patch: array<f32, PATCH>;
var<workgroup> mean_tree: array<f32, PATCH>;
var<workgroup> distances: array<f32, CANDIDATES>;
var<workgroup> accepted: array<u32, CANDIDATES>;

@compute @workgroup_size(PATCH)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let reference = vec2<u32>(min(group.x * BM3D_STRIDE, params.width - BM3D_BLOCK), params.reference_y);
    let location = reference + vec2<u32>(lane % BM3D_BLOCK, lane / BM3D_BLOCK);
    let value = luma[location.y * params.width + location.x];
    reference_patch[lane] = value;
    mean_tree[lane] = value;
    workgroupBarrier();
    for (var n = PATCH / 2u; n > 0u; n /= 2u) {
        if lane < n { mean_tree[lane] += mean_tree[lane + n]; }
        workgroupBarrier();
    }
    let reference_mean = mean_tree[0] / f32(PATCH);
    let first = vec2<u32>(max(vec2<i32>(reference) - i32(BM3D_SEARCH_HALF), vec2<i32>(0)));
    let last = min(reference + vec2<u32>(BM3D_SEARCH_HALF), vec2<u32>(params.width, params.height) - vec2<u32>(BM3D_BLOCK));
    let span = last - first + vec2<u32>(1u);
    let total = span.x * span.y;
    for (var candidate = lane; candidate < total; candidate += PATCH) {
        let position = first + vec2<u32>(candidate % span.x, candidate / span.x);
        accepted[candidate] = 0u;
        if all(position == reference) { continue; }
        var pixels: array<f32, PATCH>;
        var sums: array<f32, PATCH>;
        for (var i = 0u; i < PATCH; i++) {
            let p = position + vec2<u32>(i % BM3D_BLOCK, i / BM3D_BLOCK);
            pixels[i] = luma[p.y * params.width + p.x];
            sums[i] = pixels[i];
        }
        for (var n = PATCH / 2u; n > 0u; n /= 2u) {
            for (var i = 0u; i < n; i++) { sums[i] += sums[i + n]; }
        }
        let mean = sums[0] / f32(PATCH);
        // Materialize the f32 squared residuals before their ordered sum:
        // an FMA here changes distance ties relative to the CPU reference.
        for (var i = 0u; i < PATCH; i++) {
            let delta = (reference_patch[i] - reference_mean) - (pixels[i] - mean);
            pixels[i] = delta * delta;
        }
        var distance = 0.0;
        for (var i = 0u; i < PATCH; i++) { distance += pixels[i]; }
        distance /= f32(PATCH);
        distances[candidate] = distance;
        accepted[candidate] = select(0u, 1u, distance <= threshold[0]);
    }
    workgroupBarrier();
    if lane != 0u { return; }
    output[group.x].positions[0] = reference;
    output[group.x].pad = 0u;
    for (var i = 1u; i < BM3D_GROUP_MAX; i++) { output[group.x].positions[i] = vec2<u32>(0u); }
    var count = 1u;
    for (var k = 1u; k < BM3D_GROUP_MAX; k++) {
        var best = total;
        for (var i = 0u; i < total; i++) {
            if accepted[i] == 0u { continue; }
            if best == total { best = i; }
            else if distances[i] < distances[best] { best = i; }
        }
        if best == total { break; }
        accepted[best] = 0u;
        output[group.x].positions[k] = first + vec2<u32>(best % span.x, best / span.x);
        count++;
    }
    var power = 1u;
    while power * 2u <= count { power *= 2u; }
    output[group.x].count = power;
}

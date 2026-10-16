@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> keys: array<u32>;
@group(0) @binding(2) var<storage, read> state: State;
@group(0) @binding(3) var<storage, read_write> partials: array<Partial>;
var<workgroup> sums: array<vec2<f32>, 256>;
var<workgroup> counts: array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) tid: u32, @builtin(workgroup_id) group: vec3<u32>) {
    var sum = vec2<f32>(0.0);
    var count = 0u;
    let low = state.ranks[0].key;
    let high = state.ranks[1].key;
    for (var i = group.x * 256u + tid; i < params.count; i += params.groups * 256u) {
        let key = keys[i];
        // Endpoints are added with their exact rank multiplicities in gain.wgsl.
        if key > low && key < high && key > 0x80000000u && key != 0xffffffffu {
            sum = add_sum(sum, log_luminance(key_value(key), key_value(high) <= 4.0 * AE_FLOOR));
            count++;
        }
    }
    sums[tid] = sum;
    counts[tid] = count;
    workgroupBarrier();
    for (var step = 128u; step > 0u; step >>= 1u) {
        if tid < step {
            sums[tid] = add_sum(add_sum(sums[tid], sums[tid + step].x), sums[tid + step].y);
            counts[tid] += counts[tid + step];
        }
        workgroupBarrier();
    }
    if tid == 0u { partials[group.x] = Partial(sums[0], counts[0], 0u); }
}

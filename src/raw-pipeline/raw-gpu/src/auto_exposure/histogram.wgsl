@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> keys: array<u32>;
@group(0) @binding(2) var<storage, read> state: State;
@group(0) @binding(3) var<storage, read_write> histograms: array<u32>;
var<workgroup> buckets: array<atomic<u32>, 768>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) tid: u32, @builtin(workgroup_id) group: vec3<u32>) {
    for (var rank = 0u; rank < 3u; rank++) { atomicStore(&buckets[rank * 256u + tid], 0u); }
    workgroupBarrier();
    let first = params.shift == 24u;
    // First byte has no preceding prefix. Avoid a shift by32 on that pass.
    let mask = select(0xffffffffu << min(params.shift + 8u, 31u), 0u, first);
    for (var i = group.x * 256u + tid; i < params.count; i += params.groups * 256u) {
        let key = keys[i];
        if key == 0xffffffffu { continue; }
        let digit = (key >> params.shift) & 255u;
        for (var rank = 0u; rank < 3u; rank++) {
            if first || (key & mask) == state.ranks[rank].key {
                atomicAdd(&buckets[rank * 256u + digit], 1u);
            }
        }
    }
    workgroupBarrier();
    for (var rank = 0u; rank < 3u; rank++) {
        histograms[(group.x * 3u + rank) * 256u + tid] = atomicLoad(&buckets[rank * 256u + tid]);
    }
}

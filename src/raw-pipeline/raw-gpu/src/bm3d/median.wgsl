// Exact radix selection of the upper median used by raw-core. Four byte-wide
// rounds retain the selected prefix and its rank. Only integer histograms
// use atomics; neither pixels nor floating-point sums depend on scheduling.
@group(0) @binding(1) var<storage, read> samples: array<u32>;
@group(0) @binding(2) var<storage, read_write> state: array<atomic<u32>>;
var<workgroup> bins: array<atomic<u32>, 256>;

@compute @workgroup_size(64)
fn histogram_luma(@builtin(workgroup_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    for (var i = lane; i < 256u; i += 64u) { atomicStore(&bins[i], 0u); }
    workgroupBarrier();
    let base = group_index(id) * 256u;
    let prefix = atomicLoad(&state[0]);
    let shift = p.sort.x;
    for (var i = lane; i < 256u; i += 64u) {
        if base + i >= p.control.z { continue; }
        let bits = samples[base + i];
        let key = select(bits ^ 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);
        if shift < 24u && (key >> (shift + 8u)) != (prefix >> (shift + 8u)) { continue; }
        atomicAdd(&bins[(key >> shift) & 255u], 1u);
    }
    workgroupBarrier();
    for (var i = lane; i < 256u; i += 64u) {
        let count = atomicLoad(&bins[i]);
        if count != 0u { atomicAdd(&state[4u + i], count); }
    }
}

// Separate module entry to keep its sole storage binding consecutive.

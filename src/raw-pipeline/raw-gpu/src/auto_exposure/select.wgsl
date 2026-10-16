@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> histograms: array<u32>;
@group(0) @binding(2) var<storage, read_write> state: State;
var<workgroup> buckets: array<u32, 768>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) tid: u32) {
    for (var rank = 0u; rank < 3u; rank++) {
        var total = 0u;
        for (var g = 0u; g < params.groups; g++) {
            total += histograms[(g * 3u + rank) * 256u + tid];
        }
        buckets[rank * 256u + tid] = total;
    }
    workgroupBarrier();
    if tid != 0u { return; }
    if params.shift == 24u {
        var length = 0u;
        for (var b = 0u; b < 256u; b++) { length += buckets[b]; }
        state.length = length;
        let end = min(max(length * 3u / 4u, length / 4u + 1u), length);
        state.end = end;
        let last = max(length, 1u) - 1u;
        state.ranks[0] = Rank(0u, length / 4u, 0u, 0u);
        // Select the last INCLUDED sample of [P25, P75), not the excluded
        // endpoint. A bright sample just outside the band must not choose
        // the numerical scale used for a near-black geometric mean.
        state.ranks[1] = Rank(0u, max(end, 1u) - 1u, 0u, 0u);
        let p95 = (length / 100u) * 95u + (length % 100u) * 95u / 100u;
        state.ranks[2] = Rank(0u, min(p95, last), 0u, 0u);
    }
    if state.length == 0u { return; }
    for (var rank = 0u; rank < 3u; rank++) {
        var before = 0u;
        let wanted = state.ranks[rank].residual;
        for (var digit = 0u; digit < 256u; digit++) {
            let count = buckets[rank * 256u + digit];
            if before + count > wanted {
                state.ranks[rank].key |= digit << params.shift;
                state.ranks[rank].residual = wanted - before;
                state.ranks[rank].multiplicity = count;
                break;
            }
            before += count;
        }
    }
}

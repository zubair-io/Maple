@group(0) @binding(1) var<storage, read_write> state: array<u32>;

@compute @workgroup_size(64)
fn select_luma(@builtin(local_invocation_index) lane: u32) {
    if lane != 0u { return; }
    var rank = state[1];
    if p.sort.x == 24u { rank = p.control.z / 2u; }
    for (var i = 0u; i < 256u; i++) {
        let count = state[4u + i];
        if rank < count {
            let key = state[0] | (i << p.sort.x);
            state[0] = key;
            state[1] = rank;
            state[2] = select(~key, key ^ 0x80000000u, (key & 0x80000000u) != 0u);
            return;
        }
        rank -= count;
    }
}

@group(0) @binding(1) var<storage,read> flags:array<u32>;
@group(0) @binding(2) var<storage,read> blocks:array<u32>;
@group(0) @binding(3) var<storage,read_write> worklist:array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
    let i=index(id);
    if i>=p.cache.z*p.cache.w { return; }
    let packed=flags[i];
    if (packed&1u)==0u { return; }
    let rank=blocks[i/p.stream.z]+(packed>>1u);
    worklist[1u+rank]=i;
}

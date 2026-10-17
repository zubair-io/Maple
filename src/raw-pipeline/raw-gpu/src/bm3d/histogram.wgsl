@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> keys:array<u32>;
@group(0) @binding(2) var<storage,read> state:Rank;
@group(0) @binding(3) var<storage,read_write> histograms:array<u32>;
var<workgroup> buckets:array<atomic<u32>,256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3<u32>) {
    atomicStore(&buckets[lane],0u);
    workgroupBarrier();
    let first=params.shift==24u;
    let mask=select(0xffffffffu << min(params.shift+8u,31u),0u,first);
    let count=(params.width*params.height+7u)/8u;
    for(var i=group.x*256u+lane;i<count;i+=params.groups*256u) {
        let key=keys[i];
        if first || (key & mask)==state.key {atomicAdd(&buckets[(key >> params.shift) & 255u],1u);}
    }
    workgroupBarrier();
    histograms[group.x*256u+lane]=atomicLoad(&buckets[lane]);
}

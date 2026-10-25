@group(0) @binding(1) var<storage,read> selected:array<u32>;
@group(0) @binding(2) var<storage,read_write> flags:array<u32>;
@group(0) @binding(3) var<storage,read_write> blocks:array<u32>;
var<workgroup> scan_a:array<u32,64>;
var<workgroup> scan_b:array<u32,64>;
var<workgroup> subgroup_totals:array<u32,2>;


@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) id:vec3<u32>,@builtin(local_invocation_index) lane:u32) {
    let block=group_index(id);
    let count=p.cache.z*p.cache.w;
    if block>=(count+p.stream.z-1u)/p.stream.z { return; }
    var value=vec4<u32>(0u);
    for (var q=0u;q<4u;q++) {
        let i=block*p.stream.z+lane*4u+q;
        if i<count {
            let xy=p.cache.xy+vec2<u32>(i%p.cache.z,i/p.cache.z);
            value[q]=selected[xy.y*p.dims.x+xy.x];
        }
    }
    let sum=value.x+value.y+value.z+value.w;
    var rank=local_prefix(lane,sum);
    if lane==63u { blocks[block]=rank+sum; }
    for (var q=0u;q<4u;q++) {
        let i=block*p.stream.z+lane*4u+q;
        if i<count { flags[i]=(rank<<1u)|value[q]; }
        rank+=value[q];
    }
}

@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> original:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> noisy:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read> filtered:array<vec4<f32>>;
@group(0) @binding(4) var<storage,read_write> output:array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>,@builtin(num_workgroups) groups:vec3<u32>) {
    let i=id.y*groups.x*64u+id.x;
    if i>=params.width*params.height {return;}
    let delta=filtered[i].xyz-noisy[i].xyz;
    let dr=delta.x+delta.y;
    let db=delta.x+delta.z;
    let dg=(delta.x-BM3D_LUMA[0]*dr-BM3D_LUMA[2]*db)/BM3D_LUMA[1];
    output[i]=vec4<f32>(original[i].xyz+vec3<f32>(dr,dg,db),original[i].w);
}

@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> input:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> opponent:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read_write> keys:array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>,@builtin(num_workgroups) groups:vec3<u32>) {
    let i=id.y*groups.x*64u+id.x;
    if i>=params.width*params.height {return;}
    let p=input[i];
    var products:array<f32,3>;
    for(var c=0u;c<3u;c++){products[c]=p[c]*BM3D_LUMA[c];}
    var y=products[0];
    for(var c=1u;c<3u;c++){y+=products[c];}
    opponent[i]=vec4<f32>(y,p.x-y,p.z-y,p.w);
    if i%8u==0u {
        let bits=bitcast<u32>(y);
        keys[i/8u]=select(bits ^ 0x80000000u,~bits,(bits & 0x80000000u)!=0u);
    }
}

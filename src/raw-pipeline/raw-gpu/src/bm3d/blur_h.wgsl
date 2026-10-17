@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> original:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> blurred:array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>,@builtin(num_workgroups) groups:vec3<u32>) {
    let i=id.y*groups.x*64u+id.x;
    if i>=params.width*params.height {return;}
    let x=i%params.width;
    let v=original[i].x;
    var numer=0.0;
    var denom=BM3D_KW[0];
    for(var d=1u;d<=2u;d++) {
        if x>=d {numer+=BM3D_KW[d]*(original[i-d].x-v);denom+=BM3D_KW[d];}
        if x+d<params.width {numer+=BM3D_KW[d]*(original[i+d].x-v);denom+=BM3D_KW[d];}
    }
    blurred[i]=v+numer/denom;
}

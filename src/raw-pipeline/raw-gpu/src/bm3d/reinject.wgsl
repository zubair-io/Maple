@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> original:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> horizontal:array<f32>;
@group(0) @binding(3) var<storage,read_write> filtered:array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>,@builtin(num_workgroups) groups:vec3<u32>) {
    let i=id.y*groups.x*64u+id.x;
    if i>=params.width*params.height {return;}
    let y=i/params.width;
    let v=horizontal[i];
    var numer=0.0;
    var denom=BM3D_KW[0];
    for(var d=1u;d<=2u;d++) {
        if y>=d {numer+=BM3D_KW[d]*(horizontal[i-d*params.width]-v);denom+=BM3D_KW[d];}
        if y+d<params.height {numer+=BM3D_KW[d]*(horizontal[i+d*params.width]-v);denom+=BM3D_KW[d];}
    }
    let blurred=v+numer/denom;
    let highpass=original[i].x-blurred;
    filtered[i].x+=BM3D_HF_K*params.strength*highpass;
}

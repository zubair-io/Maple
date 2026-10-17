@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> state:Rank;
@group(0) @binding(2) var<storage,read_write> noise:array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
    if id.x!=0u {return;}
    let anchor=key_value(state.key)+BM3D_ANCHOR_PEDESTAL;
    let sigma=BM3D_SIGMA_K*params.strength*anchor;
    noise[0]=BM3D_T_MATCH_SQ*sigma*sigma;
    noise[1]=sigma;
    noise[2]=BM3D_CHROMA_SIGMA_RATIO*sigma;
    noise[3]=noise[2];
}

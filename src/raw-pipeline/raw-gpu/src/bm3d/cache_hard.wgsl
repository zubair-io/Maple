@group(0) @binding(1) var<storage,read> noisy:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> worklist:array<u32>;
@group(0) @binding(3) var<storage,read_write> spectra:array<f32>;
// Eight patches per group, packing noisy/guide pairs into vector registers.
var<workgroup> work_a:array<vec4<f32>,256>;
var<workgroup> work_b:array<vec4<f32>,256>;
var<workgroup> cache_means:array<vec4<f32>,4>;



// The hard pass has no guide: pack four noisy patches in each vector.
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) id:vec3<u32>,@builtin(local_invocation_index) lane:u32) {
    let first=group_index(id)*p.stream.w;
    let coefficient=lane%64u;let slot=lane/64u;
    var value=vec4<f32>(0.0);
    var positions=vec4<u32>(0u);
    for (var q=0u;q<4u;q++) {
        let task=first+slot+q*4u;
        if task<worklist[0] {
            let at=worklist[1u+task];
            positions[q]=at;
            let origin=p.cache.xy+vec2<u32>(at%p.cache.z,at/p.cache.z);
            let pixel=(origin.y+coefficient/8u)*p.dims.x+origin.x+coefficient%8u;
            value[q]=opponent(noisy[pixel].rgb,p.control.x);
        }
    }
    let mean=cache_mean(value,lane);
    let v=cache_transform(value-mean,lane);
    for (var q=0u;q<4u;q++) {
        if first+slot+q*4u<worklist[0] {
            let at=positions[q];
            spectra[at*65u+1u+coefficient]=v[q];
            if coefficient==0u { spectra[at*65u]=mean[q]; }
        }
    }
}

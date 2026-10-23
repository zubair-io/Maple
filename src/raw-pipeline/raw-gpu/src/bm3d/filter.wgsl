@group(0) @binding(1) var<storage,read> spectra:array<f32>;
@group(0) @binding(2) var<storage,read> groups:array<u32>;
@group(0) @binding(3) var<storage,read_write> estimates:array<f32>;

@compute @workgroup_size(256)
fn filter_groups(@builtin(workgroup_id) id:vec3<u32>,@builtin(local_invocation_index) lane:u32) {
    let local_group=group_index(id);
    if local_group>=p.batch.z*p.batch.w { return; }
    let g=(p.batch.y+local_group/p.batch.z)*p.dims.z+p.batch.x+local_group%p.batch.z;
    let base=4u+g*17u;
    let n=groups[base];
    let block=lane/16u;
    let member=lane%16u;
    let wiener=p.control.y!=0u;
    let sigma=bitcast<f32>(groups[0])*select(p.scale.y,1.0,p.control.x==0u);
    var v=vec4<f32>(0.0);
    var b=vec4<f32>(0.0);
    if block==0u { means[member]=0.0;guide_means[member]=0.0; }
    if member<n {
        let position=groups[base+1u+member];
        let xy=unpack_patch(position)-p.cache.xy;
        let at=xy.y*p.cache.z+xy.x;
        for (var q=0u;q<4u;q++) {
            let coefficient=block+q*16u;
            v[q]=spectra[at*65u+1u+coefficient];
            if wiener { b[q]=spectra[(p.stream.x+at)*65u+1u+coefficient]; }
        }
        if block==0u {
            means[member]=spectra[at*65u];
            if wiener { guide_means[member]=spectra[(p.stream.x+at)*65u]; }
        }
    }
    workgroupBarrier();
    v = group_axis(v,lane,n);
    if wiener { b = group_axis(b,lane,n); }
    var contribution=vec4<f32>(0.0);
    if wiener {
        let gain=b*b/(b*b+vec4<f32>(sigma*sigma));
        v*=gain;contribution=gain*gain;
    } else {
        let retained=abs(v)>=vec4<f32>(p.scale.w*sigma);
        v=select(vec4<f32>(0.0),v,retained);
        contribution=select(vec4<f32>(0.0),vec4<f32>(1.0),retained);
    }
    if member>=n { contribution=vec4<f32>(0.0); }
    coefficient_weights(contribution,lane,n);
    finish_means(lane,n,wiener,sigma);
    v = group_axis(v,lane,n);
    v = inverse_spatial(v,lane);
    let coefficient=lane%64u;let slot=lane/64u;
    let out=(p.control.x*p.stream.y+local_group)*1025u;
    if lane==0u { estimates[out]=weight; }
    for (var q=0u;q<4u;q++) {
        let k=slot+q*4u;
        if k<n { estimates[out+1u+k*64u+coefficient]=v[q]+means[k]; }
    }
}

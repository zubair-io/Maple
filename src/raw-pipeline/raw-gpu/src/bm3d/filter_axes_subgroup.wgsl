// Used after probing contiguous 32/64-lane subgroups.
fn group_axis(value:vec4<f32>,lane:u32,n:u32)->vec4<f32> {
    var v=value;
    for (var h=1u;h<16u;h*=2u) {
        let other=subgroupShuffleXor(v,h);
        if h<n { v=select(other-v,v+other,vec4<bool>((lane&h)==0u))*0.7071067811865476; }
    }
    return v;
}

fn coefficient_weights(value:vec4<f32>,lane:u32,n:u32) {
    var sum=value;
    let member=lane%16u;
    for (var step=8u;step>0u;step/=2u) {
        let other=subgroupShuffleDown(sum,step);
        if member<step { sum+=other; }
    }
    if member==0u { for (var q=0u;q<4u;q++) { stats[lane/16u+q*16u]=sum[q]; } }
    workgroupBarrier();
}

fn inverse_spatial(value:vec4<f32>,lane:u32)->vec4<f32> {
    let v=inverse_vertical_transpose(value,lane);
    let col=lane%8u;
    let origin=(lane%SUBGROUP_WIDTH)/8u*8u;
    var sum=vec4<f32>(0.0);
    sum+=subgroupShuffle(v,origin+0u)*basis(0u,col);
    sum+=subgroupShuffle(v,origin+1u)*basis(1u,col);
    sum+=subgroupShuffle(v,origin+2u)*basis(2u,col);
    sum+=subgroupShuffle(v,origin+3u)*basis(3u,col);
    sum+=subgroupShuffle(v,origin+4u)*basis(4u,col);
    sum+=subgroupShuffle(v,origin+5u)*basis(5u,col);
    sum+=subgroupShuffle(v,origin+6u)*basis(6u,col);
    sum+=subgroupShuffle(v,origin+7u)*basis(7u,col);

    return sum;
}

fn finish_means(lane:u32,n:u32,wiener:bool,sigma:f32) {
    var total=0.0;
    if lane<64u { total=stats[lane]; }
    total=subgroupAdd(total);
    if lane%SUBGROUP_WIDTH==0u { work_b[lane/SUBGROUP_WIDTH]=vec4<f32>(total,0.0,0.0,0.0); }
    let anchor=means[0];
    let guide_anchor=guide_means[0];
    var m=vec2<f32>(means[lane%16u]-anchor,guide_means[lane%16u]-guide_anchor);
    for (var h=1u;h<16u;h*=2u) {
        let neighbor=subgroupShuffleXor(m,h);
        if h<n { m=select(neighbor-m,m+neighbor,vec2<bool>((lane&h)==0u))*0.7071067811865476; }
    }
    var contribution=0.0;
    if lane<n {
        if wiener {
            let b2=m.y*m.y;
            let gain=b2/(b2+(sigma/8.0)*(sigma/8.0));
            m.x*=gain;contribution=gain*gain;
        } else {
            if abs(m.x)<p.scale.w*(sigma/8.0) { m.x=0.0; } else { contribution=1.0; }
        }
    }
    let mean_weight=subgroupAdd(contribution);
    for (var h=1u;h<16u;h*=2u) {
        let neighbor=subgroupShuffleXor(m.x,h);
        if h<n { m.x=select(neighbor-m.x,m.x+neighbor,(lane&h)==0u)*0.7071067811865476; }
    }
    if lane<n { means[lane]=anchor+m.x; }
    workgroupBarrier();
    if lane==0u {
        var total_weight=work_b[0].x;
        if SUBGROUP_WIDTH==32u { total_weight+=work_b[1].x; }
        weight=1.0/(select(1.0,1e-8,wiener)+total_weight+mean_weight);
    }
    workgroupBarrier();
}

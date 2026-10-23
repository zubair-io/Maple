// Used only after the native probe confirms contiguous 32/64-lane subgroups.
fn patch_means_fast(value:vec4<f32>,lane:u32,is_guide:bool,n:u32) {
    let coefficient=lane%64u;
    let slot=lane/64u;
    var sum=value;
    if SUBGROUP_WIDTH==32u {
        work_a[lane]=sum;
        workgroupBarrier();
        if coefficient<32u { sum+=work_a[lane+32u]; }
    }
    var first=32u;
    if SUBGROUP_WIDTH==32u { first=16u; }
    for (var step=first;step>0u;step/=2u) {
        let neighbor=subgroupShuffleDown(sum,step);
        if coefficient<step { sum+=neighbor; }
    }
    if coefficient==0u {
        for (var q=0u;q<4u;q++) {
            let k=slot+4u*q;
            if k<n {
                if is_guide { guide_means[k]=sum[q]/64.0; } else { means[k]=sum[q]/64.0; }
            }
        }
    }
    workgroupBarrier();
}

fn spatial_transform_fast(value:vec4<f32>,lane:u32,inverse:bool)->vec4<f32> {
    let coefficient=lane%64u;
    let slot=lane/64u;
    let row=coefficient/8u;
    let col=coefficient%8u;
    let subgroup_row=(lane%SUBGROUP_WIDTH)/8u*8u;
    var v=value;
    for (var axis=0u;axis<2u;axis++) {
        let vertical=(axis==1u)!=inverse;
        var sum=vec4<f32>(0.0);
        if vertical {
            work_a[lane]=v;
            workgroupBarrier();
            for (var j=0u;j<8u;j++) {
                var b=basis(row,j);if inverse { b=basis(j,row); }
                sum+=work_a[slot*64u+j*8u+col]*b;
            }
            // The next transform may reuse work_a immediately.
            workgroupBarrier();
        } else {
            for (var j=0u;j<8u;j++) {
                let a=subgroupShuffle(v,subgroup_row+j);
                var b=basis(col,j);if inverse { b=basis(j,col); }
                sum+=a*b;
            }
        }
        v=sum;
    }
    return v;
}

fn finish_means_fast(lane:u32,n:u32,wiener:bool,sigma:f32) {
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

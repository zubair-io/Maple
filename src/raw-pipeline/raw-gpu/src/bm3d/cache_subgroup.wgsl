fn cache_mean(value:vec4<f32>,lane:u32)->vec4<f32> {
    let coefficient=lane%64u;
    var sum=value;
    if SUBGROUP_WIDTH==32u {
        work_a[lane]=sum;
        workgroupBarrier();
        if coefficient<32u { sum+=work_a[lane+32u]; }
    }
    var first=32u;if SUBGROUP_WIDTH==32u { first=16u; }
    for (var step=first;step>0u;step/=2u) {
        let other=subgroupShuffleDown(sum,step);
        if coefficient<step { sum+=other; }
    }
    if coefficient==0u { cache_means[lane/64u]=sum/64.0; }
    workgroupBarrier();
    return cache_means[lane/64u];
}

fn cache_transform(value:vec4<f32>,lane:u32)->vec4<f32> {
    let coefficient=lane%64u;
    let row=coefficient/8u;let col=coefficient%8u;let slot=lane/64u;
    let origin=(lane%SUBGROUP_WIDTH)/8u*8u;
    var horizontal=vec4<f32>(0.0);
    horizontal+=select(subgroupShuffle(value,origin+0u)-subgroupShuffle(value,origin+7u),subgroupShuffle(value,origin+0u)+subgroupShuffle(value,origin+7u),vec4<bool>(col%2u==0u))*basis(col,0u);
    horizontal+=select(subgroupShuffle(value,origin+1u)-subgroupShuffle(value,origin+6u),subgroupShuffle(value,origin+1u)+subgroupShuffle(value,origin+6u),vec4<bool>(col%2u==0u))*basis(col,1u);
    horizontal+=select(subgroupShuffle(value,origin+2u)-subgroupShuffle(value,origin+5u),subgroupShuffle(value,origin+2u)+subgroupShuffle(value,origin+5u),vec4<bool>(col%2u==0u))*basis(col,2u);
    horizontal+=select(subgroupShuffle(value,origin+3u)-subgroupShuffle(value,origin+4u),subgroupShuffle(value,origin+3u)+subgroupShuffle(value,origin+4u),vec4<bool>(col%2u==0u))*basis(col,3u);
    work_a[lane]=horizontal;
    workgroupBarrier();
    var vertical=vec4<f32>(0.0);
    vertical+=select(work_a[slot*64u+0u+col]-work_a[slot*64u+56u+col],work_a[slot*64u+0u+col]+work_a[slot*64u+56u+col],vec4<bool>(row%2u==0u))*basis(row,0u);
    vertical+=select(work_a[slot*64u+8u+col]-work_a[slot*64u+48u+col],work_a[slot*64u+8u+col]+work_a[slot*64u+48u+col],vec4<bool>(row%2u==0u))*basis(row,1u);
    vertical+=select(work_a[slot*64u+16u+col]-work_a[slot*64u+40u+col],work_a[slot*64u+16u+col]+work_a[slot*64u+40u+col],vec4<bool>(row%2u==0u))*basis(row,2u);
    vertical+=select(work_a[slot*64u+24u+col]-work_a[slot*64u+32u+col],work_a[slot*64u+24u+col]+work_a[slot*64u+32u+col],vec4<bool>(row%2u==0u))*basis(row,3u);
    return vertical;
}

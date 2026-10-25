fn cache_mean(value:vec4<f32>,lane:u32)->vec4<f32> {
    let coefficient=lane%64u;
    var sum=value;
    var phase=0u;
    for (var step=32u;step>0u;step/=2u) {
        if phase%2u==0u { work_a[lane]=sum; } else { work_b[lane]=sum; }
        workgroupBarrier();
        if coefficient<step {
            if phase%2u==0u { sum+=work_a[lane+step]; } else { sum+=work_b[lane+step]; }
        }
        phase++;
    }
    if coefficient==0u { cache_means[lane/64u]=sum/64.0; }
    workgroupBarrier();
    return cache_means[lane/64u];
}

fn cache_transform(value:vec4<f32>,lane:u32)->vec4<f32> {
    let coefficient=lane%64u;
    let slot=lane/64u;
    let row=coefficient/8u;let col=coefficient%8u;
    var v=value;
    for (var axis=0u;axis<2u;axis++) {
        if axis==0u { work_a[lane]=v; } else { work_b[lane]=v; }
        workgroupBarrier();
        var sum=vec4<f32>(0.0);
        for (var j=0u;j<8u;j++) {
            var i=slot*64u+row*8u+j;var b=basis(col,j);
            if axis==1u { i=slot*64u+j*8u+col;b=basis(row,j); }
            var a=work_a[i];if axis==1u { a=work_b[i]; }
            sum+=a*b;
        }
        v=sum;
    }
    return v;
}

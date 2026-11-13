fn group_axis(value:vec4<f32>,lane:u32,n:u32)->vec4<f32> {
    var v=value;
    var phase=0u;
    for (var h=1u;h<16u;h*=2u) {
        if phase%2u==0u { work_a[lane]=v; } else { work_b[lane]=v; }
        workgroupBarrier();
        if h<n {
            var other=work_a[lane^h];if phase%2u!=0u { other=work_b[lane^h]; }
            v=select(other-v,v+other,vec4<bool>((lane&h)==0u))*0.7071067811865476;
        }
        phase++;
    }
    return v;
}

fn coefficient_weights(value:vec4<f32>,lane:u32,n:u32) {
    work_a[lane]=value;
    workgroupBarrier();
    let block=lane/16u;
    if lane%16u==0u {
        var sum=vec4<f32>(0.0);
        for (var k=0u;k<n;k++) { sum+=work_a[block*16u+k]; }
        for (var q=0u;q<4u;q++) { stats[block+q*16u]=sum[q]; }
    }
    workgroupBarrier();
}

fn inverse_spatial(value:vec4<f32>,lane:u32)->vec4<f32> {
    let v=inverse_vertical_transpose(value,lane);
    let coefficient=lane%64u;let slot=lane/64u;
    let row=coefficient/8u;let col=coefficient%8u;
    var sum=vec4<f32>(0.0);
    for (var j=0u;j<8u;j++) {
        let first=((row%2u)*8u+j)*16u+slot;
        let a=vec4<f32>(work_b[first][row/2u],work_b[first+4u][row/2u],work_b[first+8u][row/2u],work_b[first+12u][row/2u]);
        sum+=a*basis(j,col);
    }
    return sum;
}

fn mean_wht(n: u32, is_guide: bool) {
    for (var h = 1u; h < n; h *= 2u) {
        for (var i = 0u; i < n; i += 2u*h) {
            for (var j = i; j < i+h; j++) {
                var a = means[j]; var b = means[j+h];
                if is_guide { a = guide_means[j]; b = guide_means[j+h]; }
                let sum = (a+b)*0.7071067811865476;
                let difference = (a-b)*0.7071067811865476;
                if is_guide { guide_means[j]=sum; guide_means[j+h]=difference; }
                else { means[j]=sum; means[j+h]=difference; }
            }
        }
    }
}

fn finish_means(lane:u32,n:u32,wiener:bool,sigma:f32) {
    if lane == 0u {
        let anchor=means[0]; let guide_anchor=guide_means[0];
        for (var k=0u;k<n;k++) { means[k]-=anchor; if wiener { guide_means[k]-=guide_anchor; } }
        mean_wht(n,false);
        if wiener { mean_wht(n,true); }
        var total=0.0;
        for (var i=0u;i<64u;i++) { total+=stats[i]; }
        for (var k=0u;k<n;k++) {
            if wiener {
                let b2=guide_means[k]*guide_means[k];
                let gain=b2/(b2+(sigma/8.0)*(sigma/8.0));
                means[k]*=gain; total+=gain*gain;
            } else {
                if abs(means[k])<p.scale.w*(sigma/8.0) { means[k]=0.0; } else { total+=1.0; }
            }
        }
        mean_wht(n,false);
        for (var k=0u;k<n;k++) { means[k]+=anchor; }
        weight=1.0/(select(1.0,1e-8,wiener)+total);
    }
    workgroupBarrier();
}

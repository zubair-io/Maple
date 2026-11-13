fn local_prefix(lane:u32,value:u32)->u32 {
    var sum=value;
    var phase=0u;
    for (var step=1u;step<64u;step*=2u) {
        if phase%2u==0u { scan_a[lane]=sum; } else { scan_b[lane]=sum; }
        workgroupBarrier();
        if lane>=step {
            if phase%2u==0u { sum+=scan_a[lane-step]; } else { sum+=scan_b[lane-step]; }
        }
        phase++;
    }
    return sum-value;
}

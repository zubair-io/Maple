// Same bitonic total order as the portable network. Small exchanges stay
// in subgroup registers; cross-subgroup stages use explicit shared barriers.
fn sort_candidates(lane:u32) {
    var d=vec2<f32>(distances[lane],distances[lane+256u]);
    var at=vec2<u32>(locations[lane],locations[lane+256u]);
    for (var size=2u;size<=512u;size*=2u) {
        for (var stride=size/2u;stride>0u;stride/=2u) {
            var neighbor_d:vec2<f32>;
            var neighbor_at:vec2<u32>;
            if stride<SUBGROUP_WIDTH {
                neighbor_d=subgroupShuffleXor(d,stride);
                neighbor_at=subgroupShuffleXor(at,stride);
            } else {
                distances[lane]=d.x;distances[lane+256u]=d.y;
                locations[lane]=at.x;locations[lane+256u]=at.y;
                workgroupBarrier();
                let first=lane^stride;let second=(lane+256u)^stride;
                neighbor_d=vec2<f32>(distances[first],distances[second]);
                neighbor_at=vec2<u32>(locations[first],locations[second]);
            }
            for (var q=0u;q<2u;q++) {
                let i=lane+q*256u;
                let minimum=((i&size)==0u)==((i&stride)==0u);
                let greater=d[q]>neighbor_d[q] || (d[q]==neighbor_d[q] && at[q]>neighbor_at[q]);
                let less=d[q]<neighbor_d[q] || (d[q]==neighbor_d[q] && at[q]<neighbor_at[q]);
                if (minimum && greater) || (!minimum && less) { d[q]=neighbor_d[q];at[q]=neighbor_at[q]; }
            }
            if stride>=SUBGROUP_WIDTH { workgroupBarrier(); }
        }
    }
    distances[lane]=d.x;distances[lane+256u]=d.y;
    locations[lane]=at.x;locations[lane+256u]=at.y;
    workgroupBarrier();
}

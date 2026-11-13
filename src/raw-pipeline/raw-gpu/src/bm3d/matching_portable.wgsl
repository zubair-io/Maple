fn sort_candidates(lane:u32) {
    // Total ordering is (distance, scan index), including exact ties. The
    // fixed network parallelizes selection while retaining CPU match order.
    for (var size = 2u; size <= 512u; size *= 2u) {
        for (var stride = size / 2u; stride > 0u; stride /= 2u) {
            for (var i = lane; i < 512u; i += 256u) {
                let j = i ^ stride;
                if j <= i { continue; }
                let a = distances[i];
                let b = distances[j];
                let ai = locations[i];
                let bi = locations[j];
                let greater = a > b || (a == b && ai > bi);
                let less = a < b || (a == b && ai < bi);
                let ascending = (i & size) == 0u;
                if (ascending && greater) || (!ascending && less) {
                    distances[i] = b; distances[j] = a;
                    locations[i] = bi; locations[j] = ai;
                }
            }
            workgroupBarrier();
        }
    }
}

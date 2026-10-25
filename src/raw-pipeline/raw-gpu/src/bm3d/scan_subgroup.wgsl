fn local_prefix(lane:u32,value:u32)->u32 {
    let rank=subgroupExclusiveAdd(value);
    let total=subgroupAdd(value);
    if lane%SUBGROUP_WIDTH==0u { subgroup_totals[lane/SUBGROUP_WIDTH]=total; }
    workgroupBarrier();
    var offset=0u;
    if SUBGROUP_WIDTH==32u && lane>=32u { offset=subgroup_totals[0]; }
    return rank+offset;
}

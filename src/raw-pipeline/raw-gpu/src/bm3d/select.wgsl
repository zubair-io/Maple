@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> histograms:array<u32>;
@group(0) @binding(2) var<storage,read_write> state:Rank;
var<workgroup> buckets:array<u32,256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lane:u32) {
    var total=0u;
    for(var g=0u;g<params.groups;g++){total+=histograms[g*256u+lane];}
    buckets[lane]=total;
    workgroupBarrier();
    if lane!=0u {return;}
    if params.shift==24u {state=Rank(0u,((params.width*params.height+7u)/8u)/2u,0u,0u);}
    var before=0u;
    for(var digit=0u;digit<256u;digit++) {
        let count=buckets[digit];
        if before+count>state.residual {
            state.key |= digit << params.shift;
            state.residual-=before;
            break;
        }
        before+=count;
    }
}

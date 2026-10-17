struct Params {
    frame: vec2<u32>, patch_size: vec2<u32>, center: vec2<i32>, source: vec2<i32>,
    offset: vec2<i32>, kernel_len: u32, pad: u32,
    radius: f32, feather: f32, opacity: f32, pad_float: f32,
};
@group(0) @binding(0) var<uniform> params: Params;

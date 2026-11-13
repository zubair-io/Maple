// Android's Vulkan float swapchain uses EXTENDED_SRGB_LINEAR_EXT. Preserve the
// existing Display P3 view transform and quantization, then transport that color
// in unbounded linear sRGB. The compositor converts it to the physical display.
// Matrix helpers are generated from raw-core; EOTF is gated against view::gamma.
fn present_degamma(value: f32) -> f32 {
    if (value <= 0.04045) { return value / 12.92; }
    return pow((value + 0.055) / 1.055, 2.4);
}

@fragment
fn fs_scrgb(in: VsOut) -> @location(0) vec4<f32> {
    let p3 = present_color(in);
    let linear = vec3<f32>(present_degamma(p3.r), present_degamma(p3.g), present_degamma(p3.b));
    return vec4<f32>(mul_p3_to_srgb(linear), 1.0);
}

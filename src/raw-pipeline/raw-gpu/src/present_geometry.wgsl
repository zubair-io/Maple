// Quantize in sensor coordinates, then orient, perspective, and crop (#3982).
// Each bilinear stage narrows separately, matching raw-core's integer tail.
fn display_narrow(value: vec3<f32>) -> vec3<f32> {
    return floor(clamp(value + vec3<f32>(0.5), vec3<f32>(0.0), vec3<f32>(255.0)));
}

fn quantized_oriented_pixel(point: vec2<i32>) -> vec3<f32> {
    let p = vec3<f32>(vec2<f32>(point), 1.0);
    let sensor = vec2<u32>(
        u32(dot(params.orientation0.xyz, p)),
        u32(dot(params.orientation1.xyz, p)),
    );
    let c = chain_buf[sensor.y * params.src_width + sensor.x].rgb;
    let off = blue_noise_offset_lsb(sensor.x, sensor.y);
    return floor(clamp(c * 255.0 + vec3<f32>(off + 0.5), vec3<f32>(0.0), vec3<f32>(255.0)));
}

fn bilinear_quantized_oriented(source: vec2<f32>) -> vec3<f32> {
    let base = vec2<i32>(floor(source));
    let maximum = vec2<i32>(params.tail_dimensions.xy) - vec2<i32>(1);
    if (base.x + 1 < 0 || base.y + 1 < 0 || base.x > maximum.x || base.y > maximum.y) {
        return vec3<f32>(0.0);
    }
    let fraction = source - vec2<f32>(base);
    let lo = clamp(base, vec2<i32>(0), maximum);
    let hi = clamp(base + vec2<i32>(1), vec2<i32>(0), maximum);
    let p00 = quantized_oriented_pixel(lo);
    let p10 = quantized_oriented_pixel(vec2<i32>(hi.x, lo.y));
    let p01 = quantized_oriented_pixel(vec2<i32>(lo.x, hi.y));
    let p11 = quantized_oriented_pixel(hi);
    let fx = fraction.x;
    let fy = fraction.y;
    return display_narrow(p00 * ((1.0-fx)*(1.0-fy)) + p10 * (fx*(1.0-fy))
        + p01 * ((1.0-fx)*fy) + p11 * (fx*fy));
}

fn perspective_quantized_pixel(point: vec2<i32>) -> vec3<f32> {
    if (params.geom_row0.w == 0.0) {
        return quantized_oriented_pixel(point);
    }
    let half_size = vec2<f32>(params.tail_dimensions.xy) / 2.0;
    let normalized = (vec2<f32>(point) + vec2<f32>(0.5)) / half_size - vec2<f32>(1.0);
    let homogeneous = vec3<f32>(normalized, 1.0);
    let divisor = dot(params.geom_row2.xyz, homogeneous);
    if (abs(divisor) < 1.0e-6) { return vec3<f32>(0.0); }
    let mapped = vec2<f32>(dot(params.geom_row0.xyz, homogeneous),
        dot(params.geom_row1.xyz, homogeneous)) / divisor;
    return bilinear_quantized_oriented((mapped + vec2<f32>(1.0)) * half_size - vec2<f32>(0.5));
}

fn bilinear_quantized_perspective(source: vec2<f32>) -> vec3<f32> {
    let base = vec2<i32>(floor(source));
    let maximum = vec2<i32>(params.tail_dimensions.xy) - vec2<i32>(1);
    if (base.x + 1 < 0 || base.y + 1 < 0 || base.x > maximum.x || base.y > maximum.y) {
        return vec3<f32>(0.0);
    }
    let fraction = source - vec2<f32>(base);
    let lo = clamp(base, vec2<i32>(0), maximum);
    let hi = clamp(base + vec2<i32>(1), vec2<i32>(0), maximum);
    let p00 = perspective_quantized_pixel(lo);
    let p10 = perspective_quantized_pixel(vec2<i32>(hi.x, lo.y));
    let p01 = perspective_quantized_pixel(vec2<i32>(lo.x, hi.y));
    let p11 = perspective_quantized_pixel(hi);
    let fx = fraction.x;
    let fy = fraction.y;
    return display_narrow(p00 * ((1.0-fx)*(1.0-fy)) + p10 * (fx*(1.0-fy))
        + p01 * ((1.0-fx)*fy) + p11 * (fx*fy));
}

fn quantized_display_tail(point: vec2<u32>) -> vec3<f32> {
    if (params.tail_dimensions.w == 0u) {
        let p = vec3<f32>(vec2<f32>(point), 1.0);
        return perspective_quantized_pixel(vec2<i32>(
            i32(round(dot(params.crop0.xyz, p))), i32(round(dot(params.crop1.xyz, p)))));
    }
    let center = vec2<f32>(params.tail_dimensions.xy) / 2.0;
    let delta = params.crop_rotation.xy + vec2<f32>(point) + vec2<f32>(0.5) - center;
    let c = params.crop_rotation.z;
    let s = params.crop_rotation.w;
    let source = vec2<f32>(delta.x*c - delta.y*s + center.x - 0.5,
        delta.x*s + delta.y*c + center.y - 0.5);
    return bilinear_quantized_perspective(source);
}

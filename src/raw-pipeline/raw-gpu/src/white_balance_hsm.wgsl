// white_balance_hsm.wgsl — the live white-balance delta carrying the
// white-balance-retargeted HueSatMap (#5099).
//
// Line-for-line port of `raw_core::stages::wb_camera::HsmRetargetView::
// apply_pixel` and the `raw_core::color::hsm` kernel it runs:
//
//   out = floor( from_pro · H_T( delta_pro · H_A⁻¹( to_pro · b ) ) )
//
// `H_w` is the HueSatMap blended between the cold and warm endpoint tables
// at weight `w` (corresponding cells blended on the shorter hue arc before
// spatial interpolation); `H_A⁻¹` is an HSV-space inverse of
// `inverse_iterations` steps; `floor` lifts a negative channel uniformly, as
// the develop's DCP exit does. The two tables are session-constant storage;
// a tick only changes the uniform.
//
// Matrices arrive as vec4 ROWS (see white_balance.wgsl for why not mat3x3).

struct Params {
    to_pro0: vec4<f32>,
    to_pro1: vec4<f32>,
    to_pro2: vec4<f32>,
    delta0: vec4<f32>,
    delta1: vec4<f32>,
    delta2: vec4<f32>,
    from_pro0: vec4<f32>,
    from_pro1: vec4<f32>,
    from_pro2: vec4<f32>,
    count: u32,
    hue_divs: u32,
    sat_divs: u32,
    val_divs: u32,
    srgb: u32,
    table_len: u32,
    w_target: f32,
    w_anchor: f32,
    inverse_iterations: u32,
    lift_bisection_steps: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
// Cold table then warm table, `table_len` floats each, laid out as
// `HsmTable::data`: ((h * sat_divs + s) * val_divs + v) * 3 + channel.
@group(0) @binding(3) var<storage, read> tables: array<f32>;

fn mat_rows(r0: vec4<f32>, r1: vec4<f32>, r2: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(dot(r0.xyz, v), dot(r1.xyz, v), dot(r2.xyz, v));
}

fn rem_euclid(x: f32, m: f32) -> f32 {
    let r = x - m * trunc(x / m);
    return select(r, r + m, r < 0.0);
}

fn srgb_encode(v: f32) -> f32 {
    let c = max(v, 0.0);
    return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, 12.92 * c, c <= 0.0031308);
}

fn srgb_decode(v: f32) -> f32 {
    return select(pow((v + 0.055) / 1.055, 2.4), v / 12.92, v <= 0.04045);
}

fn rgb_to_hsv(rgb: vec3<f32>) -> vec3<f32> {
    let r = rgb.x;
    let g = rgb.y;
    let b = rgb.z;
    let mx = max(max(r, g), b);
    let mn = min(min(r, g), b);
    let delta = mx - mn;
    var s = 0.0;
    if (mx > 0.0) {
        s = delta / mx;
    }
    var h = 0.0;
    if (s <= 0.0 || delta < 1e-9) {
        h = 0.0;
    } else if (abs(mx - r) < 1e-9) {
        h = 60.0 * rem_euclid((g - b) / delta, 6.0);
    } else if (abs(mx - g) < 1e-9) {
        h = 60.0 * (((b - r) / delta) + 2.0);
    } else {
        h = 60.0 * (((r - g) / delta) + 4.0);
    }
    if (h < 0.0) {
        h = h + 360.0;
    } else if (h >= 360.0) {
        h = h - 360.0;
    }
    return vec3<f32>(h, s, mx);
}

fn hsv_to_rgb(h_in: f32, s: f32, v: f32) -> vec3<f32> {
    if (s <= 0.0) {
        return vec3<f32>(v, v, v);
    }
    let h = rem_euclid(h_in, 360.0);
    let c = v * s;
    let h6 = h / 60.0;
    let x = c * (1.0 - abs((h6 - 2.0 * trunc(h6 / 2.0)) - 1.0));
    var rgb1 = vec3<f32>(c, 0.0, x);
    if (h6 < 1.0) {
        rgb1 = vec3<f32>(c, x, 0.0);
    } else if (h6 < 2.0) {
        rgb1 = vec3<f32>(x, c, 0.0);
    } else if (h6 < 3.0) {
        rgb1 = vec3<f32>(0.0, c, x);
    } else if (h6 < 4.0) {
        rgb1 = vec3<f32>(0.0, x, c);
    } else if (h6 < 5.0) {
        rgb1 = vec3<f32>(x, 0.0, c);
    }
    let m = v - c;
    return rgb1 + vec3<f32>(m, m, m);
}

fn entry(base: u32, h: u32, s: u32, v: u32) -> vec3<f32> {
    let i = base + ((h * params.sat_divs + s) * params.val_divs + v) * 3u;
    return vec3<f32>(tables[i], tables[i + 1u], tables[i + 2u]);
}

fn unwrap_hue(value: f32, reference: f32) -> f32 {
    var diff = value - reference;
    if (diff > 180.0) {
        diff = diff - 360.0;
    }
    if (diff < -180.0) {
        diff = diff + 360.0;
    }
    return reference + diff;
}

fn signed_degrees(degrees: f32) -> f32 {
    let m = degrees - 360.0 * trunc(degrees / 360.0);
    if (m > 180.0) {
        return m - 360.0;
    }
    if (m < -180.0) {
        return m + 360.0;
    }
    return m;
}

// `hsm::lookup`: trilinear, hue wraps, sat/val clamp, hue axis unwrapped
// against the first corner; returns (signed hueDelta, satScale, valScale).
fn lookup_blended(w: f32, hue: f32, sat: f32, val: f32) -> vec3<f32> {
    let hd = i32(params.hue_divs);
    let sd = i32(params.sat_divs);
    let vd = i32(params.val_divs);

    let h_pos = (hue / 360.0) * f32(hd);
    let h_lo = i32(floor(h_pos));
    let fx = h_pos - f32(h_lo);
    let h0 = u32(((h_lo % hd) + hd) % hd);
    let h1 = u32((((h_lo + 1) % hd) + hd) % hd);

    let s_pos = clamp(sat, 0.0, 1.0) * f32(sd - 1);
    let s_lo = i32(floor(s_pos));
    let fy = s_pos - f32(s_lo);
    let s0 = u32(clamp(s_lo, 0, sd - 1));
    let s1 = u32(clamp(s_lo + 1, 0, sd - 1));

    var v0 = 0u;
    var v1 = 0u;
    var fz = 0.0;
    if (vd > 1) {
        let v_pos = clamp(val, 0.0, 1.0) * f32(vd - 1);
        let v_lo = i32(floor(v_pos));
        fz = v_pos - f32(v_lo);
        v0 = u32(clamp(v_lo, 0, vd - 1));
        v1 = u32(clamp(v_lo + 1, 0, vd - 1));
    }

    let c000 = blended_entry(clamp(w, 0.0, 1.0), h0, s0, v0);
    let c100 = blended_entry(clamp(w, 0.0, 1.0), h1, s0, v0);
    let c010 = blended_entry(clamp(w, 0.0, 1.0), h0, s1, v0);
    let c110 = blended_entry(clamp(w, 0.0, 1.0), h1, s1, v0);
    let c001 = blended_entry(clamp(w, 0.0, 1.0), h0, s0, v1);
    let c101 = blended_entry(clamp(w, 0.0, 1.0), h1, s0, v1);
    let c011 = blended_entry(clamp(w, 0.0, 1.0), h0, s1, v1);
    let c111 = blended_entry(clamp(w, 0.0, 1.0), h1, s1, v1);

    let r = c000.x;
    let a000 = vec3<f32>(r, c000.yz);
    let a100 = vec3<f32>(unwrap_hue(c100.x, r), c100.yz);
    let a010 = vec3<f32>(unwrap_hue(c010.x, r), c010.yz);
    let a110 = vec3<f32>(unwrap_hue(c110.x, r), c110.yz);
    let a001 = vec3<f32>(unwrap_hue(c001.x, r), c001.yz);
    let a101 = vec3<f32>(unwrap_hue(c101.x, r), c101.yz);
    let a011 = vec3<f32>(unwrap_hue(c011.x, r), c011.yz);
    let a111 = vec3<f32>(unwrap_hue(c111.x, r), c111.yz);

    let lo0 = a000 * (1.0 - fx) + a100 * fx;
    let lo1 = a010 * (1.0 - fx) + a110 * fx;
    let hi0 = a001 * (1.0 - fx) + a101 * fx;
    let hi1 = a011 * (1.0 - fx) + a111 * fx;
    let low = lo0 * (1.0 - fy) + lo1 * fy;
    let high = hi0 * (1.0 - fy) + hi1 * fy;
    let out = low * (1.0 - fz) + high * fz;
    return vec3<f32>(signed_degrees(out.x), out.y, out.z);
}

fn shorter_arc(diff: f32) -> f32 {
    if (diff > 180.0) {
        return diff - 360.0;
    }
    if (diff < -180.0) {
        return diff + 360.0;
    }
    return diff;
}

// Blend the lattice cell exactly as hsm::lerp_tables, before lookup unwraps
// neighboring cells against the first corner.
fn blended_entry(t: f32, h: u32, s: u32, v: u32) -> vec3<f32> {
    let cold = entry(0u, h, s, v);
    let warm = entry(params.table_len, h, s, v);
    var hue = cold.x + t * shorter_arc(warm.x - cold.x);
    if (hue > 360.0) { hue = hue - 360.0; }
    if (hue < -360.0) { hue = hue + 360.0; }
    return vec3<f32>(hue, (1.0 - t) * cold.yz + t * warm.yz);
}

// `hsm::apply_one_with` over the blended table.
fn apply_table(p: vec3<f32>, w: f32) -> vec3<f32> {
    let min_original = min(min(p.x, p.y), p.z);
    let lift = select(0.0, -min_original, min_original < 0.0);
    var rgb = p + vec3<f32>(lift, lift, lift);
    if (params.srgb != 0u) {
        rgb = vec3<f32>(srgb_encode(rgb.x), srgb_encode(rgb.y), srgb_encode(rgb.z));
    }
    let hsv = rgb_to_hsv(rgb);
    let shift = lookup_blended(w, hsv.x, hsv.y, hsv.z);
    let w_chroma = clamp(hsv.y / 0.01, 0.0, 1.0);
    let hd = shift.x * w_chroma;
    let ss = 1.0 + (shift.y - 1.0) * w_chroma;
    let vs = 1.0 + (shift.z - 1.0) * w_chroma;
    let new_h = rem_euclid(hsv.x + hd, 360.0);
    let new_s = clamp(hsv.y * ss, 0.0, 1.0);
    let new_v = max(hsv.z * vs, 0.0);
    var out = hsv_to_rgb(new_h, new_s, new_v);
    if (params.srgb != 0u) {
        out = vec3<f32>(srgb_decode(out.x), srgb_decode(out.y), srgb_decode(out.z));
    }
    if (lift > 0.0) {
        return out - vec3<f32>(lift, lift, lift);
    }
    return out;
}

// `hsm_blend::deficit` / `target` / `lift_for_saturation`.
fn deficit(p: vec3<f32>) -> f32 {
    return max(-min(min(p.x, p.y), p.z), 0.0);
}

fn target_hsv(y: vec3<f32>, lift: f32) -> vec3<f32> {
    var rgb = y + vec3<f32>(lift, lift, lift);
    if (params.srgb != 0u) {
        rgb = vec3<f32>(srgb_encode(rgb.x), srgb_encode(rgb.y), srgb_encode(rgb.z));
    }
    return rgb_to_hsv(rgb);
}

fn lift_for_saturation(y: vec3<f32>, target_s: f32) -> f32 {
    let floor_lift = deficit(y);
    if (target_hsv(y, floor_lift).y <= target_s || target_s <= 0.0) {
        return floor_lift;
    }
    let lo = min(min(y.x, y.y), y.z);
    let hi = max(max(y.x, y.y), y.z);
    if (params.srgb == 0u) {
        return max((hi - lo) / target_s - hi, floor_lift);
    }
    let span = max(hi - lo, 1e-6);
    var upper = floor_lift + span * 1e9;
    for (var k = 0u; k < 32u; k = k + 1u) {
        let l = floor_lift + span * f32(1u << min(k, 30u));
        if (target_hsv(y, l).y <= target_s) {
            upper = l;
            break;
        }
    }
    var a = floor_lift;
    var b = upper;
    for (var k = 0u; k < params.lift_bisection_steps; k = k + 1u) {
        let mid = 0.5 * (a + b);
        if (target_hsv(y, mid).y > target_s) {
            a = mid;
        } else {
            b = mid;
        }
    }
    return 0.5 * (a + b);
}

// `hsm::invert_one_blended`: the pre-image solved in HSV, each step undoing
// the shift read at the current estimate; a boundary pre-image under a
// desaturating table also re-solves the forward's lift.
fn invert_table(y: vec3<f32>, w: f32) -> vec3<f32> {
    let lifted_out = deficit(y);
    let start = target_hsv(y, lifted_out);
    var h = start.x;
    var s = start.y;
    var v = start.z;
    var lift = lifted_out;
    for (var k = 0u; k < params.inverse_iterations; k = k + 1u) {
        let shift = lookup_blended(w, h, s, v);
        let w_chroma = clamp(s / 0.01, 0.0, 1.0);
        let ss = 1.0 + (shift.y - 1.0) * w_chroma;
        let vs = 1.0 + (shift.z - 1.0) * w_chroma;
        let on_boundary = lifted_out > 0.0 || s >= 1.0;
        lift = select(lifted_out, lift_for_saturation(y, ss), on_boundary && ss < 1.0);
        let tgt = target_hsv(y, lift);
        h = rem_euclid(tgt.x - shift.x * w_chroma, 360.0);
        s = select(clamp(tgt.y / max(ss, 1e-6), 0.0, 1.0), 1.0, lift > 0.0);
        v = tgt.z / max(vs, 1e-6);
    }
    var out = hsv_to_rgb(h, s, v);
    if (params.srgb != 0u) {
        out = vec3<f32>(srgb_decode(out.x), srgb_decode(out.y), srgb_decode(out.z));
    }
    return out - vec3<f32>(lift, lift, lift);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let p = mat_rows(params.to_pro0, params.to_pro1, params.to_pro2, px.rgb);
    let x = invert_table(p, params.w_anchor);
    let moved = apply_table(mat_rows(params.delta0, params.delta1, params.delta2, x), params.w_target);
    let out = mat_rows(params.from_pro0, params.from_pro1, params.from_pro2, moved);
    let floor_lift = max(-min(min(out.x, out.y), out.z), 0.0);
    output_buf[i] = vec4<f32>(out + vec3<f32>(floor_lift, floor_lift, floor_lift), px.a);
}

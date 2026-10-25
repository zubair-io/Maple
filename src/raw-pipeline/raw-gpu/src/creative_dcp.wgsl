// creative_dcp.wgsl — the creative half of the capture-first order (#5376):
//
//   pro = T_to_pro · capture            (target camera matrix, white balance
//                                        gain and the inverse capture basis)
//   pro = LookTable( HueSatMap_target( pro ) )       in linear ProPhoto D50
//   out = soft_floor( pro→Rec.2020 · pro )
//
// Line-for-line port of `raw_core::color::dcp::apply_colorimetry`'s table
// path: the HueSatMap through `hsm::apply_one` (trilinear, the two endpoint
// tables blended per cell on the shorter hue arc first, as `hsm::lerp_tables`
// does), the LookTable through `dcp::apply_look_table` (tetrahedral). With no
// table the two matrices were folded on the CPU into `to_pro`, as the CPU
// fast path folds them. Matrices arrive as vec4 ROWS (see white_balance.wgsl).

struct Params {
    to_pro0: vec4<f32>,
    to_pro1: vec4<f32>,
    to_pro2: vec4<f32>,
    from_pro0: vec4<f32>,
    from_pro1: vec4<f32>,
    from_pro2: vec4<f32>,
    count: u32,
    hsm_mode: u32,
    look_mode: u32,
    hsm_weight: f32,
    hsm_hue: u32,
    hsm_sat: u32,
    hsm_val: u32,
    hsm_srgb: u32,
    hsm_blend: u32,
    look_hue: u32,
    look_sat: u32,
    look_val: u32,
    look_srgb: u32,
    hsm_cold_offset: u32,
    hsm_warm_offset: u32,
    look_offset: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
// Every table of the profile back to back, each laid out as `HsmTable::data`:
// offset + ((h * sat_divs + s) * val_divs + v) * 3 + channel.
@group(0) @binding(3) var<storage, read> tables: array<f32>;

struct Lattice {
    hue: u32,
    sat: u32,
    val: u32,
    srgb: u32,
};

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

fn shorter_arc(diff: f32) -> f32 {
    if (diff > 180.0) {
        return diff - 360.0;
    }
    if (diff < -180.0) {
        return diff + 360.0;
    }
    return diff;
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

fn lattice_index(lat: Lattice, h: u32, s: u32, v: u32) -> u32 {
    return ((h * lat.sat + s) * lat.val + v) * 3u;
}

// The HueSatMap cell at warm weight `t`: both endpoint tables blended before
// lookup unwraps neighbouring cells (`hsm::lerp_tables`); one table when the
// profile has no second illuminant.
fn hsm_entry(lat: Lattice, t: f32, h: u32, s: u32, v: u32) -> vec3<f32> {
    let i = params.hsm_cold_offset + lattice_index(lat, h, s, v);
    let cold = vec3<f32>(tables[i], tables[i + 1u], tables[i + 2u]);
    if (params.hsm_blend == 0u) {
        return cold;
    }
    let j = params.hsm_warm_offset + lattice_index(lat, h, s, v);
    let warm = vec3<f32>(tables[j], tables[j + 1u], tables[j + 2u]);
    var hue = cold.x + t * shorter_arc(warm.x - cold.x);
    if (hue > 360.0) { hue = hue - 360.0; }
    if (hue < -360.0) { hue = hue + 360.0; }
    return vec3<f32>(hue, (1.0 - t) * cold.yz + t * warm.yz);
}

fn look_entry(lat: Lattice, h: u32, s: u32, v: u32) -> vec3<f32> {
    let i = params.look_offset + lattice_index(lat, h, s, v);
    return vec3<f32>(tables[i], tables[i + 1u], tables[i + 2u]);
}

// `hsm::lookup`: trilinear, hue wraps, sat/val clamp, hue axis unwrapped
// against the first corner; returns (signed hueDelta, satScale, valScale).
fn lookup_hsm(lat: Lattice, t: f32, hue: f32, sat: f32, val: f32) -> vec3<f32> {
    let hd = i32(lat.hue);
    let sd = i32(lat.sat);
    let vd = i32(lat.val);

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

    let w = clamp(t, 0.0, 1.0);
    let c000 = hsm_entry(lat, w, h0, s0, v0);
    let c100 = hsm_entry(lat, w, h1, s0, v0);
    let c010 = hsm_entry(lat, w, h0, s1, v0);
    let c110 = hsm_entry(lat, w, h1, s1, v0);
    let c001 = hsm_entry(lat, w, h0, s0, v1);
    let c101 = hsm_entry(lat, w, h1, s0, v1);
    let c011 = hsm_entry(lat, w, h0, s1, v1);
    let c111 = hsm_entry(lat, w, h1, s1, v1);

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

// `dcp::lookup_tetrahedral`: the LookTable's kernel.
fn lookup_look(lat: Lattice, hue: f32, sat: f32, val: f32) -> vec3<f32> {
    let hd = i32(lat.hue);
    let sd = i32(lat.sat);
    let vd = i32(lat.val);

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

    let c000 = look_entry(lat, h0, s0, v0);
    let c100 = look_entry(lat, h1, s0, v0);
    let c010 = look_entry(lat, h0, s1, v0);
    let c110 = look_entry(lat, h1, s1, v0);
    let c001 = look_entry(lat, h0, s0, v1);
    let c101 = look_entry(lat, h1, s0, v1);
    let c011 = look_entry(lat, h0, s1, v1);
    let c111 = look_entry(lat, h1, s1, v1);

    let r = c000.x;
    let v000 = vec3<f32>(r, c000.yz);
    let v100 = vec3<f32>(unwrap_hue(c100.x, r), c100.yz);
    let v010 = vec3<f32>(unwrap_hue(c010.x, r), c010.yz);
    let v110 = vec3<f32>(unwrap_hue(c110.x, r), c110.yz);
    let v001 = vec3<f32>(unwrap_hue(c001.x, r), c001.yz);
    let v101 = vec3<f32>(unwrap_hue(c101.x, r), c101.yz);
    let v011 = vec3<f32>(unwrap_hue(c011.x, r), c011.yz);
    let v111 = vec3<f32>(unwrap_hue(c111.x, r), c111.yz);

    var out = vec3<f32>(0.0);
    if (fx >= fy) {
        if (fy >= fz) {
            out = v000 * (1.0 - fx) + v100 * (fx - fy) + v110 * (fy - fz) + v111 * fz;
        } else if (fx >= fz) {
            out = v000 * (1.0 - fx) + v100 * (fx - fz) + v101 * (fz - fy) + v111 * fy;
        } else {
            out = v000 * (1.0 - fz) + v001 * (fz - fx) + v101 * (fx - fy) + v111 * fy;
        }
    } else {
        if (fx >= fz) {
            out = v000 * (1.0 - fy) + v010 * (fy - fx) + v110 * (fx - fz) + v111 * fz;
        } else if (fy >= fz) {
            out = v000 * (1.0 - fy) + v010 * (fy - fz) + v011 * (fz - fx) + v111 * fx;
        } else {
            out = v000 * (1.0 - fz) + v001 * (fz - fy) + v011 * (fy - fx) + v111 * fx;
        }
    }
    return vec3<f32>(rem_euclid(out.x, 360.0), out.y, out.z);
}

// `hsm::apply_one_with` / `dcp::apply_look_table`: the shared HSV correction,
// `look_kernel` choosing the lookup.
fn apply_table(p: vec3<f32>, lat: Lattice, look_kernel: bool) -> vec3<f32> {
    let min_original = min(min(p.x, p.y), p.z);
    let lift = select(0.0, -min_original, min_original < 0.0);
    var rgb = p + vec3<f32>(lift, lift, lift);
    if (lat.srgb != 0u) {
        rgb = vec3<f32>(srgb_encode(rgb.x), srgb_encode(rgb.y), srgb_encode(rgb.z));
    }
    let hsv = rgb_to_hsv(rgb);
    var shift = vec3<f32>(0.0);
    if (look_kernel) {
        shift = lookup_look(lat, hsv.x, hsv.y, hsv.z);
    } else {
        shift = lookup_hsm(lat, params.hsm_weight, hsv.x, hsv.y, hsv.z);
    }
    let w_chroma = clamp(hsv.y / 0.01, 0.0, 1.0);
    let hd = shift.x * w_chroma;
    let ss = 1.0 + (shift.y - 1.0) * w_chroma;
    let vs = 1.0 + (shift.z - 1.0) * w_chroma;
    let new_h = rem_euclid(hsv.x + hd, 360.0);
    let new_s = clamp(hsv.y * ss, 0.0, 1.0);
    let new_v = max(hsv.z * vs, 0.0);
    var out = hsv_to_rgb(new_h, new_s, new_v);
    if (lat.srgb != 0u) {
        out = vec3<f32>(srgb_decode(out.x), srgb_decode(out.y), srgb_decode(out.z));
    }
    if (lift > 0.0) {
        return out - vec3<f32>(lift, lift, lift);
    }
    return out;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    var pro = mat_rows(params.to_pro0, params.to_pro1, params.to_pro2, px.rgb);
    if (params.hsm_mode != 0u) {
        pro = apply_table(pro, Lattice(params.hsm_hue, params.hsm_sat, params.hsm_val, params.hsm_srgb), false);
    }
    if (params.look_mode != 0u) {
        pro = apply_table(pro, Lattice(params.look_hue, params.look_sat, params.look_val, params.look_srgb), true);
    }
    var out = pro;
    if (params.hsm_mode != 0u || params.look_mode != 0u) {
        out = mat_rows(params.from_pro0, params.from_pro1, params.from_pro2, pro);
    }
    let floor_lift = max(-min(min(out.x, out.y), out.z), 0.0);
    output_buf[i] = vec4<f32>(out + vec3<f32>(floor_lift, floor_lift, floor_lift), px.a);
}

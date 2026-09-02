using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Native
{
    /// <summary>
    /// C-ABI mirror of raw-ffi's MapleSceneLinearBufferF32 (buffers.rs).
    /// Populated by maple_render_*_scene_linear_*_f32; the pixel and
    /// noise-profile allocations are Rust-owned — free the whole struct via
    /// RawFfi.maple_free_scene_linear_buffer_f32, never individually.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public unsafe struct MapleSceneLinearBufferF32
    {
        public float* f32_rgba;
        public nuint len_bytes;            // 16 * width * height
        public uint channels;              // always 4
        public uint bytes_per_pixel;       // always 16
        public uint width;
        public uint height;
        public float* noise_profile_data;  // owned by this struct; freed with it
        public uint noise_profile_len;
        public uint iso;
        public fixed float wb_frame_m_cold[9];
        public float wb_frame_cct_cold;
        public fixed float wb_frame_m_warm[9];
        public float wb_frame_cct_warm;
        public float wb_frame_scene_cct;   // <= 0 means the frame block is absent
        public float wb_frame_as_shot_tint;
        public fixed float wb_frame_render_cm[9];
        public fixed float wb_frame_render_forward_matrix[9];
        public fixed float wb_frame_render_scene_white_xyz[3];
        public float wb_frame_render_wb_already_baked;
        public fixed float wb_frame_render_cm_cold[9];
        public float wb_frame_render_cct_cold;
        public fixed float wb_frame_render_cm_warm[9];
        public float wb_frame_render_cct_warm;
        public fixed float wb_frame_render_fm_cold[9];
        public fixed float wb_frame_render_fm_warm[9];
        public float ae_gain;
        // Lens-correction decode signals (#2231, #3189) — pre-existing gap on
        // this mirror: the Rust struct appended `has_lens_corrections` and
        // `lens_correction_ca_inert` after `ae_gain` in #2231, but this C#
        // side was never updated to match, so `write_scene_linear_buf_f32`
        // has been writing those two fields into whatever came after this
        // struct's old end since #2231 landed. Added here alongside #3189's
        // new `lens_correction_distortion_inert` field, in the exact Rust
        // declaration order.
        public uint has_lens_corrections;
        public uint lens_correction_ca_inert;
        public uint lens_correction_distortion_inert;
    }

    /// <summary>
    /// C-ABI mirror of raw-ffi's MapleToneCurves (scene_linear_chain_curves.rs,
    /// #2576): flat [x0,y0,x1,y1,...] knot lists for the curves-aware CPU chain
    /// entry; len counts floats (2× points). Null/empty = identity.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public unsafe struct MapleToneCurves
    {
        public float* luma_ptr;
        public nuint luma_len;
        public float* red_ptr;
        public nuint red_len;
        public float* green_ptr;
        public nuint green_len;
        public float* blue_ptr;
        public nuint blue_len;
        public uint mode;                  // 0 = PerChannel, 1 = RatioPreserving
    }

    /// <summary>
    /// C-ABI mirror of raw-ffi's MapleGpuLiveSession (gpu_live.rs): an opaque
    /// handle struct the host allocates and maple_gpu_live_open fills in.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct MapleGpuLiveSession
    {
        public IntPtr inner;
    }

    /// <summary>
    /// C-ABI mirror of raw-ffi's MapleAutoAdjustments (auto_adjustments.rs):
    /// one-shot AUTO recommendation. The returned exposure REPLACES the
    /// auto-exposure anchor — the caller must also set AutoExposure = Off.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct MapleAutoAdjustments
    {
        public float exposure;
        public float temperature;
        public float tint;
        public float contrast;
        public float highlights;
        public float shadows;
        public float whites;
        public float blacks;
    }
}

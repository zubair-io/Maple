using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Native
{
    /// <summary>
    /// P/Invoke bindings for raw_ffi.dll — the Rust core (`src/raw-pipeline/raw-ffi`)
    /// built as a cdylib via `cargo build --release -p raw-ffi --features gpu`.
    /// All entries are cdecl; i32 returns use 0 = success with the message
    /// available from maple_last_error() on the SAME thread as the failing call.
    /// </summary>
    public static unsafe partial class RawFfi
    {
        private const string Dll = "raw_ffi.dll";

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_apply_geometry_f32(float* pixels, float* scratch, uint width, uint height,
            float perspectiveH, float perspectiveV, float rotation, float aspect, float scale);

        /// <summary>
        /// Guards the hand-mirrored struct layouts against drift from the Rust
        /// declarations (fields are append-only at the tail). Call once at startup.
        /// </summary>
        public static void VerifyAbi()
        {
            var paramsSize = sizeof(MapleAdjustmentParams);
            if (paramsSize != 672)
                throw new InvalidOperationException(
                    $"MapleAdjustmentParams is {paramsSize} bytes; the Rust ABI expects 672. " +
                    "The C# mirror has drifted from raw-ffi/src/scene_linear_chain.rs.");
        }

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern IntPtr maple_last_error();

        public static string? LastError()
        {
            var ptr = maple_last_error();
            return ptr == IntPtr.Zero ? null : Marshal.PtrToStringUTF8(ptr);
        }

        // --- Decode: scene-linear f32 (preferred family; supports cancellation) ---

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_render_file_scene_linear_sized_f32(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath,
            uint maxLongEdge,
            int qualityPreview,
            IntPtr cancelFlag,
            MapleSceneLinearBufferF32* outBuffer);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern void maple_free_scene_linear_buffer_f32(
            MapleSceneLinearBufferF32* buffer);

        // --- Per-tick chain: scene-linear f32 in → display-encoded sRGB f32 out.
        //     Aliasing in/out is explicitly permitted for this fused entry. ---

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_apply_chain_and_encode_display_f32(
            float* inPtr, uint width, uint height,
            MapleAdjustmentParams* p, float* outPtr);

        // Curves-aware sibling (#2576): the scalars-only params ABI cannot
        // carry point tone curves, so they ride a second struct. Null curves
        // pointer == the scalar entry.
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_apply_chain_and_encode_display_curves_f32(
            float* inPtr, uint width, uint height,
            MapleAdjustmentParams* p, MapleToneCurves* curves, float* outPtr);

        // --- Cancellation ---

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern IntPtr maple_cancel_flag_new();

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern void maple_cancel_flag_set(IntPtr flag);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern void maple_cancel_flag_free(IntPtr flag);

        // --- Thumbnails / previews / export (file-output entries: no buffer
        //     ownership crosses the boundary; parent directory must exist) ---

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_render_thumbnail_preview_jpeg_to_file(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string outPath,
            uint maxPx, byte quality);

        // The shared `.maple/thumbs/` grid tier (#3083): AVIF, quality 0 =
        // the FFI default 55 — the #2690 on-share write contract.
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_render_thumbnail_avif_to_file(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string outPath,
            uint maxPx, byte quality);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_render_develop_jpeg_to_file(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath,
            uint maxPx, byte quality,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string outPath);

        // Scaled present (#2587 two-phase render): the surface stays at
        // (targetW, targetH) while half- or full-res sessions present into it
        // via the shader's bilinear upscale — no reconfigure on phase swaps.
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_gpu_present_chain_winui_scaled(
            MapleGpuLiveSession* handle, MapleGpuLiveParams* p,
            IntPtr panelNative, IntPtr cancel, ulong surfaceGeneration,
            uint targetW, uint targetH);

        // Multi-format developed export (#2584): raw_core::export behind the
        // C ABI. format = "jpeg"|"tiff"|"png"; colorSpace = "srgb"|"display-p3";
        // maxLongEdge 0 = native resolution; quality 0 = default 92 (JPEG only).
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_export_developed_to_file(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string format,
            byte quality,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string colorSpace,
            uint maxLongEdge,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string outPath);

        // --- Histogram: 768 caller-owned u32 bins, channel-major R/G/B ---

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_histogram_file(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath,
            uint* outBins);

        // --- GPU live chain + WinUI SwapChainPanel present (#2561) ---

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_gpu_live_open(
            float* pixels, uint width, uint height,
            MapleGpuLiveSession* handleOut);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern void maple_gpu_live_close(
            MapleGpuLiveSession* handle);

        /// <summary>Render one edit on the live session and present it into the
        /// DXGI composition swapchain bound to the SwapChainPanel. panelNative
        /// is the ISwapChainPanelNative* (WinUI 3 DXInterop QI). 0 = presented;
        /// 4 = cancelled; any other nonzero = fall back to the CPU path.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_gpu_present_chain_winui(
            MapleGpuLiveSession* handle,
            MapleGpuLiveParams* p,
            IntPtr panelNative,
            IntPtr cancelFlag,
            ulong surfaceGeneration);

        // --- Auto Profile tail fit (#550/#924): separate curve + residual for
        //     the GPU live chain, composed display LUT for the CPU fallback.
        //     Both are cached natively per (path, mtime, quality). ---

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_gpu_fit_auto_profile(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath,
            int qualityPreview,
            float* curveOut,          // >= 220 floats (MAPLE_PROFILE_CURVE_FLAT_LEN)
            int* curvePresent,
            float* lutOut,
            nuint lutCapacityFloats,
            uint* lutSize);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_compute_auto_profile_lut(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath,
            int qualityPreview,
            uint n,
            float* outLut);           // n³ × 3 floats

        // --- AUTO adjustments ---

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_compute_auto_adjustments(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath,
            int qualityPreview,
            out MapleAutoAdjustments outAuto);

        // --- Filename-template engine (#2628): shared with Apple (C-FFI) and
        //     the Self Hosted API (bun:ffi) via the same raw-ffi symbol.
        //     Pure string logic, no filesystem access. Used directly (no
        //     template) for single-asset inline rename (#2639) — see
        //     Services/FilenameValidation.cs. ---

        /// <summary>0 = valid single filesystem path component. Non-zero:
        /// see raw-ffi/src/filename.rs's `maple_validate_filename` doc
        /// comment for the exact code table (empty / path separator /
        /// leading dot / trailing dot-or-space / reserved device name);
        /// -1 = name was null or not valid UTF-8. maple_last_error() carries
        /// the human-readable reason on any non-zero return.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_validate_filename(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string name);

        // --- Filename-template rendering (#2642, batch rename): the
        //     `_buf` counterpart to maple_render_filename_template — a
        //     caller-owned output buffer instead of a heap-allocated
        //     MapleFilenameResult, so there is nothing to free on this side
        //     (mirrors the Self Hosted API's bun:ffi shim, which uses this
        //     same `_buf` entry for the identical reason — see
        //     raw-ffi/src/filename.rs's doc comment on why
        //     maple_render_filename_template_buf exists as a sibling of the
        //     by-value-struct maple_render_filename_template). No pointer
        //     types in this signature (IntPtr for the output buffer, `out
        //     nuint` for its written length) so calling it needs no
        //     `unsafe` context, same as maple_validate_filename above. ---

        /// <summary>Render one filename from a batch-rename template
        /// (shared with Apple/Web/the Self Hosted API via the same
        /// raw-core engine). 0 = success, with the rendered UTF-8 bytes (NOT
        /// null-terminated) written to <paramref name="outBuf"/> and their
        /// length to <paramref name="outLen"/>. Non-zero: see
        /// raw-ffi/src/filename.rs's `maple_render_filename_template` doc
        /// comment for the exact code table (1-8), plus 9 = rendered name
        /// exceeds <paramref name="outCap"/>; -1 = a required pointer was
        /// null or not valid UTF-8. `maple_last_error()` carries the
        /// human-readable reason on any non-zero return. <paramref
        /// name="capturedAt"/> may be null — every `{date:FORMAT}` token
        /// then renders its documented fallback text instead of failing the
        /// call.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_render_filename_template_buf(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string template,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string originalStem,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string ext,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? capturedAt,
            ulong sequenceStart,
            ulong sequenceIndex,
            nuint sequencePadWidth,
            IntPtr outBuf,
            nuint outCap,
            out nuint outLen);
    }
}

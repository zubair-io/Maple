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
    public static unsafe class RawFfi
    {
        private const string Dll = "raw_ffi.dll";

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

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_render_develop_jpeg_to_file(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath,
            uint maxPx, byte quality,
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

        // --- AUTO adjustments ---

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_compute_auto_adjustments(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath,
            int qualityPreview,
            out MapleAutoAdjustments outAuto);
    }
}

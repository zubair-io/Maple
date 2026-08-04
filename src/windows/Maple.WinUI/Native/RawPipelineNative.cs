using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Native
{
    /// <summary>
    /// P/Invoke bindings for native `maple_core.dll` (`raw-ffi` Rust core engine).
    /// Enforces zero-copy C ABI interop for scene-linear Rec.2020 D65 pipeline execution.
    /// </summary>
    public static class RawPipelineNative
    {
        private const string DllName = "maple_core.dll";

        [StructLayout(LayoutKind.Sequential)]
        public struct MapleAdjustmentParams
        {
            public float Exposure;
            public float Brightness;
            public float Contrast;
            public float Highlights;
            public float Shadows;
            public float Whites;
            public float Blacks;
            public float Temperature;
            public float Tint;
            public float Vibrance;
            public float Saturation;
            public float Clarity;
            public float Texture;
            public float Dehaze;
            public float SharpenAmount;
            public float NoiseReductionLuma;
            public float NoiseReductionColor;
        }

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_gpu_create_winui_dxgi_swapchain(
            IntPtr hwnd,
            uint width,
            uint height,
            out IntPtr swapchainPtr);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern void maple_gpu_free_winui_dxgi_swapchain(IntPtr swapchainPtr);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern IntPtr maple_last_error();
    }
}

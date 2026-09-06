using System;
using System.Runtime.InteropServices;
using System.Text.Json;
using Maple.WinUI.Generated;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>Actual per-file resolver provenance. Qualification still comes
    /// exclusively from the generated evidence registry, never from EXIF names.</summary>
    public sealed record CameraSupportMetadata(string CameraKey, ProfileResolution Resolution, LensSupport Lens)
    {
        public CameraTier Tier => CameraSupportRegistry.TierFor(CameraKey, Resolution);
        public string Label => CameraSupportRegistry.Label(Tier);
        public string Explanation => CameraSupportRegistry.Explanation(Tier);
        public string LensLabel => CameraSupportRegistry.Label(Lens);
        public string LensExplanation => CameraSupportRegistry.Explanation(Lens);

        public static CameraSupportMetadata Parse(string json)
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            return new CameraSupportMetadata(
                root.GetProperty("cameraKey").GetString() ?? throw new JsonException("Camera key missing"),
                CameraSupportRegistry.ParseResolution(root.GetProperty("resolution").GetString() ?? ""),
                CameraSupportRegistry.ParseLens(root.GetProperty("lens").GetString() ?? ""));
        }

        /// <summary>Worker-thread only. Immediately after decode this reads the
        /// same native cached RawImage without another file read or decode.</summary>
        public static CameraSupportMetadata ReadFile(string path)
        {
            var code = CameraSupportNative.maple_camera_support_file(path, out var json);
            if (code != 0)
                throw new InvalidOperationException(RawFfi.LastError() ?? $"Camera support could not be assessed (rc={code}).");
            try
            {
                return Parse(Marshal.PtrToStringUTF8(json) ?? throw new JsonException("Support result missing"));
            }
            finally
            {
                CameraSupportNative.maple_free_camera_support(json);
            }
        }
    }

    internal static class CameraSupportNative
    {
        [DllImport("raw_ffi.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int maple_camera_support_file(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string path, out IntPtr json);

        [DllImport("raw_ffi.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern void maple_free_camera_support(IntPtr json);
    }
}

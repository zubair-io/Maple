using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Maple.WinUI.Generated;

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

        // A decoded image remains usable when the optional native metadata ABI
        // is unavailable or its payload cannot be understood by this host.
        internal static CameraSupportMetadata? ReadBestEffort(Func<CameraSupportMetadata> read)
        {
            try { return read(); }
            catch (Exception error) when (error is InvalidOperationException or JsonException
                or KeyNotFoundException or ArgumentException or DllNotFoundException
                or EntryPointNotFoundException or BadImageFormatException)
            {
                Debug.WriteLine($"Camera support remains unassessed: {error.Message}");
                return null;
            }
        }

        /// <summary>Copies optional metadata before the native decode buffer is freed.</summary>
        public static CameraSupportMetadata? ReadBuffer(IntPtr json)
        {
            if (json == IntPtr.Zero) return null;
            return ReadBestEffort(() => Parse(Marshal.PtrToStringUTF8(json) ?? ""));
        }
    }

}

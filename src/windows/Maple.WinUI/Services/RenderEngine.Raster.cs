using System;
using System.IO;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services;

public static unsafe partial class RenderEngine
{
    internal static bool IsRasterExtension(string path) => Path.GetExtension(path).ToLowerInvariant()
        is ".jpg" or ".jpeg" or ".tif" or ".tiff";

    public static void ValidateRasterAdjustments(AdjustmentState model)
    {
        var xml = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = model });
        if (RawFfi.maple_validate_raster_adjustments(xml) != 0)
            throw new InvalidDataException(RawFfi.LastError() ?? "Unsupported raster adjustments.");
    }

    private static DecodedImage DecodeRaster(string path, AdjustmentState model, int maxLongEdge, IntPtr cancellation)
    {
        ValidateRasterAdjustments(model);
        var buffer = new MapleSceneLinearBufferF32();
        var result = RawFfi.maple_decode_raster_base_file_f32(path, checked((uint)maxLongEdge), cancellation, &buffer);
        if (result == 4) throw new OperationCanceledException("Raster decode cancelled.");
        if (result != 0) throw new InvalidDataException(RawFfi.LastError() ?? "Raster decode failed.");
        try
        {
            var count = checked((int)(buffer.width * buffer.height * 4));
            var pixels = new float[count];
            new ReadOnlySpan<float>(buffer.f32_rgba, count).CopyTo(pixels);
            return new DecodedImage
            {
                Pixels = pixels, Width = (int)buffer.width, Height = (int)buffer.height,
                IsRaster = true, NoiseProfile = Array.Empty<float>(), Iso = 100, AeGain = 1,
                WhitesAnchorEv = float.NaN, DecodedTemperature = 6500, DecodedTint = 0,
                WbFrame = new float[WbFrameFloatCount],
            };
        }
        finally { RawFfi.maple_free_scene_linear_buffer_f32(&buffer); }
    }
}

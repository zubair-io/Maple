using System;
using Maple.WinUI.Models;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services;

// #5211: the 100% patch must carry the windowed chain's reported reach — the
// Shadows/Highlights mask blur grows with the frame (~530 px on 100 MP) — or
// its pixels disagree with the whole-image refine. Apple does the same (#5185).
public static unsafe class NativeDetailPatch
{
    public const uint MinimumBorder = 96;

    public static uint Border(AdjustmentState model, DecodedImage anchor, MapleRawGeometry geometry)
    {
        var parameters = MapleAdjustmentParams.From(model, anchor.DecodedTemperature, anchor.DecodedTint,
            anchor.Iso, anchor.WhitesAnchorEv, anchor.NrSamplingScale);
        var window = new MapleChainWindow { FullWidth = geometry.CropWidth, FullHeight = geometry.CropHeight };
        var layers = LocalAdjustmentFlat.ToFlat(model.LocalAdjustments);
        fixed (float* layerPtr = layers)
        {
            parameters.local_adjustments_ptr = layerPtr;
            parameters.local_adjustments_len = (nuint)layers.Length;
            return Math.Max(MinimumBorder, RawFfi.maple_scene_linear_chain_window_reach_px(&parameters, &window));
        }
    }

    public static NativeDetailRegion Expand(double x, double y, double right, double bottom,
        double margin, MapleRawGeometry geometry)
    {
        var left = (uint)Math.Max(0, Math.Floor(x - margin));
        var top = (uint)Math.Max(0, Math.Floor(y - margin));
        var r = (uint)Math.Min(geometry.CropWidth, Math.Ceiling(right + margin));
        var b = (uint)Math.Min(geometry.CropHeight, Math.Ceiling(bottom + margin));
        return new(left, top, r - left, b - top);
    }

    // The pan margin is only a prefetch, so it is dropped before the patch is;
    // null requests the whole-image refine, since a trimmed border would make
    // edge pixels disagree with it.
    public static (NativeDetailRegion Published, NativeDetailRegion Decode)? Fit(double x, double y,
        double right, double bottom, double panMargin, uint border, MapleRawGeometry geometry)
    {
        var withMargin = Expand(x, y, right, bottom, panMargin, geometry);
        var bare = Expand(x, y, right, bottom, 0, geometry);
        return DecodeRegion(withMargin, border, geometry) is { } decode ? (withMargin, decode)
            : DecodeRegion(bare, border, geometry) is { } bareDecode ? (bare, bareDecode)
            : null;
    }

    public static NativeDetailRegion? DecodeRegion(NativeDetailRegion published, uint border, MapleRawGeometry geometry)
    {
        var decode = Expand(published.X, published.Y, (double)published.X + published.Width,
            (double)published.Y + published.Height, border, geometry);
        return decode.Width <= NativeDetailDecoder.MaximumPatchEdge && decode.Height <= NativeDetailDecoder.MaximumPatchEdge
            && (ulong)decode.Width * decode.Height <= NativeDetailDecoder.MaximumPatchPixels
            ? decode
            : null;
    }
}

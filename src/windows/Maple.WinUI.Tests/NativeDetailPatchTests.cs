using System.Runtime.CompilerServices;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public class NativeDetailPatchTests
{
    // A 5400 px long edge gives one S/H pass a 122 px blur radius, so a scene edge
    // 105 px above the patch sits inside the reach but outside the old 96 px border.
    private const uint FullW = 5400, FullH = 3000;
    private static readonly MapleRawGeometry Frame = new() { CropWidth = FullW, CropHeight = FullH };
    private static readonly MapleRawGeometry HundredMp = new() { CropWidth = 11648, CropHeight = 8736 };
    private readonly ITestOutputHelper _output;

    public NativeDetailPatchTests(ITestOutputHelper output) => _output = output;

    [Fact]
    public void DecodeRegionKeepsTheBorderOnBothSidesAndClampsAtTheFrame()
    {
        Assert.Equal(new NativeDetailRegion(400, 300, 1600, 1500),
            NativeDetailPatch.DecodeRegion(new(1000, 900, 400, 300), 600, Frame));
        Assert.Equal(new NativeDetailRegion(0, 0, 700, 700),
            NativeDetailPatch.DecodeRegion(new(0, 0, 100, 100), 600, Frame));
        Assert.Equal(new NativeDetailRegion(4700, 2300, 700, 700),
            NativeDetailPatch.DecodeRegion(new(5300, 2900, 100, 100), 600, Frame));
    }

    [Fact]
    public void DecodeRegionFallsBackWhenThePaddedPatchExceedsTheDecoderLimits()
    {
        var wide = new MapleRawGeometry { CropWidth = 20000, CropHeight = 12000 };
        Assert.Null(NativeDetailPatch.DecodeRegion(new(600, 0, 15300, 400), 600, wide));
        Assert.Equal(new NativeDetailRegion(0, 0, 16384, 1000),
            NativeDetailPatch.DecodeRegion(new(600, 0, 15184, 400), 600, wide));
        var fourK = new NativeDetailRegion(2000, 2000, 4800, 2700);
        Assert.NotNull(NativeDetailPatch.DecodeRegion(fourK, NativeDetailPatch.MinimumBorder, HundredMp));
        Assert.Null(NativeDetailPatch.DecodeRegion(fourK, 592, HundredMp));
    }

    [Fact]
    public void FitDropsThePanMarginBeforeFallingBack()
    {
        var withMargin = NativeDetailPatch.Fit(3000, 3000, 6000, 5000, 400, NativeDetailPatch.MinimumBorder, HundredMp);
        Assert.Equal((new NativeDetailRegion(2600, 2600, 3800, 2800), new NativeDetailRegion(2504, 2504, 3992, 2992)),
            withMargin);
        var bare = NativeDetailPatch.Fit(3000, 3000, 6000, 5000, 400, 592, HundredMp);
        Assert.Equal((new NativeDetailRegion(3000, 3000, 3000, 2000), new NativeDetailRegion(2408, 2408, 4184, 3184)),
            bare);
        Assert.Null(NativeDetailPatch.Fit(1000, 1000, 6000, 4000, 400, 592, HundredMp));
    }

    [NativeFilmFact]
    public void BorderIsTheChainReachWithShadowsHighlightsAndTheMinimumOtherwise()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var off = new AdjustmentState();
        var on = new AdjustmentState { Shadows = 60, Highlights = -60 };
        foreach (var geometry in new[] { Frame, HundredMp })
        {
            var offReach = Reach(off, geometry);
            var onReach = Reach(on, geometry);
            _output.WriteLine($"{geometry.CropWidth}x{geometry.CropHeight}: reach S/H off {offReach}, on {onReach}");
            Assert.True(offReach < NativeDetailPatch.MinimumBorder);
            Assert.Equal(NativeDetailPatch.MinimumBorder, NativeDetailPatch.Border(off, Anchor(), geometry));
            Assert.True(onReach > NativeDetailPatch.MinimumBorder);
            Assert.Equal(onReach, NativeDetailPatch.Border(on, Anchor(), geometry));
        }
    }

    [NativeFilmFact]
    public unsafe void ReachBorderedPatchMatchesTheFullFrameAndTheFixedBorderDoesNot()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var model = new AdjustmentState { Shadows = 60, Highlights = -60, SharpenAmount = 0, NrColor = 0 };
        var neutral = new AdjustmentState { SharpenAmount = 0, NrColor = 0 };
        var input = TexturedFrame();
        var published = new NativeDetailRegion(2600, 1305, 160, 120);
        var full = Interior(FullFrame(input, model), FullW, new(0, 0, FullW, FullH), published);
        var unedited = Interior(FullFrame(input, neutral), FullW, new(0, 0, FullW, FullH), published);
        Assert.True(MaxAbs(full, unedited) > 1e-2, "S/H must move the render");
        var border = NativeDetailPatch.Border(model, Anchor(), Frame);
        var matched = MaxAbs(full, Patch(input, model, published, border));
        var fixedBorder = MaxAbs(full, Patch(input, model, published, NativeDetailPatch.MinimumBorder));
        _output.WriteLine($"border {border}: max |Δ| {matched}; 96 px border: max |Δ| {fixedBorder}");
        Assert.True(border > NativeDetailPatch.MinimumBorder);
        Assert.True(matched <= 1e-4, $"reach-bordered patch differs by {matched}");
        Assert.True(fixedBorder > 5e-4, $"96 px border unexpectedly matched ({fixedBorder})");
    }

    private static unsafe uint Reach(AdjustmentState model, MapleRawGeometry geometry)
    {
        var parameters = MapleAdjustmentParams.From(model, 6500, 0, 100, 0);
        var window = new MapleChainWindow { FullWidth = geometry.CropWidth, FullHeight = geometry.CropHeight };
        return RawFfi.maple_scene_linear_chain_window_reach_px(&parameters, &window);
    }

    private static DecodedImage Anchor() => new()
    {
        Pixels = [], Width = 0, Height = 0, NoiseProfile = [], Iso = 100, AeGain = 1,
        WhitesAnchorEv = 0, DecodedTemperature = 6500, DecodedTint = 0, WbFrame = [],
    };

    private static float[] TexturedFrame()
    {
        var frame = new float[FullW * FullH * 4];
        for (var y = 0u; y < FullH; y++)
            for (var x = 0u; x < FullW; x++)
            {
                var sky = y < 1200 ? 1.6f : .06f;
                var block = (int)(x / 37f) % 3 == 0 ? .5f : 1f;
                var v = MathF.Max(.002f, sky * block + .08f * MathF.Sin(x * .31f) * MathF.Cos(y * .17f));
                var i = (y * FullW + x) * 4;
                (frame[i], frame[i + 1], frame[i + 2], frame[i + 3]) = (v * 1.05f, v, v * .82f, 1f);
            }
        return frame;
    }

    private static unsafe float[] FullFrame(float[] input, AdjustmentState model)
    {
        var parameters = MapleAdjustmentParams.From(model, 6500, 0, 100, 0);
        var output = new float[input.Length];
        fixed (float* source = input)
        fixed (float* result = output)
            Assert.Equal(0, RawFfi.maple_apply_chain_and_encode_display_curves_f32(source, FullW, FullH, &parameters, null, result));
        return output;
    }

    private static unsafe float[] Patch(float[] input, AdjustmentState model, NativeDetailRegion published, uint border)
    {
        var decode = NativeDetailPatch.DecodeRegion(published, border, Frame)!.Value;
        var patch = Interior(input, FullW, new(0, 0, FullW, FullH), decode);
        var output = new float[patch.Length];
        var parameters = MapleAdjustmentParams.From(model, 6500, 0, 100, 0);
        var window = new MapleChainWindow { X = decode.X, Y = decode.Y, FullWidth = FullW, FullHeight = FullH };
        fixed (float* source = patch)
        fixed (float* result = output)
            Assert.Equal(0, RawFfi.ApplyWindow(source, decode.Width, decode.Height, &parameters, null,
                IntPtr.Zero, 0, &window, IntPtr.Zero, result));
        return Interior(output, decode.Width, decode, published);
    }

    private static float[] Interior(float[] pixels, uint stride, NativeDetailRegion source, NativeDetailRegion region)
    {
        var result = new float[region.Width * region.Height * 4];
        for (var row = 0u; row < region.Height; row++)
            Array.Copy(pixels, ((region.Y - source.Y + row) * stride + region.X - source.X) * 4,
                result, row * region.Width * 4, region.Width * 4);
        return result;
    }

    private static float MaxAbs(float[] a, float[] b) =>
        a.Zip(b, (x, y) => MathF.Abs(x - y)).Max();
}

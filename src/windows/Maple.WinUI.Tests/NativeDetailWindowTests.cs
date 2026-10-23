using System.Runtime.CompilerServices;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Xunit;

namespace Maple.WinUI.Tests;

public class NativeDetailWindowTests
{
    [NativeFilmFact]
    public unsafe void NativeWindowMatchesFullFrameMasksVignetteGrainAndFilm()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var input = Enumerable.Range(0, 96 * 80).SelectMany(i => new[] {
            .05f + i % 96 / 170f, .12f + i / 96 / 250f, .23f, 1f }).ToArray();
        var model = new AdjustmentState { SharpenAmount = 0, NrColor = 0,
            VignetteAmount = -45, GrainAmount = 35 };
        model.LocalAdjustments.Add(new(new RadialMask(new(.7, .3), new(.4, .5), 0, .5, false),
            new PartialAdjustments { Exposure = -1 }));
        var layers = LocalAdjustmentFlat.ToFlat(model.LocalAdjustments);
        var parameters = MapleAdjustmentParams.From(model, 6500, 0, 100, 0);
        using var film = FilmLutHandle.Create(2, Enumerable.Repeat(new[] { .2f, .4f, .1f }, 8).SelectMany(x => x).ToArray());
        fixed (float* source = input)
        fixed (float* masks = layers)
        {
            parameters.local_adjustments_ptr = masks;
            parameters.local_adjustments_len = (nuint)layers.Length;
            foreach (var withFilm in new[] { false, true })
            {
                var full = new float[input.Length];
                fixed (float* output = full)
                    Assert.Equal(0, withFilm
                        ? RawFfi.maple_apply_chain_and_encode_display_curves_film_f32(source, 96, 80, &parameters, null, film, 37, output)
                        : RawFfi.maple_apply_chain_and_encode_display_curves_f32(source, 96, 80, &parameters, null, output));
                foreach (var (x, y) in new[] { (0, 0), (55, 51), (21, 27) })
                {
                    var patch = Crop(input, x, y);
                    var actual = new float[patch.Length];
                    var window = new MapleChainWindow { X = (uint)x, Y = (uint)y, FullWidth = 96, FullHeight = 80 };
                    fixed (float* pixels = patch)
                    fixed (float* result = actual)
                        Assert.Equal(0, withFilm
                            ? RawFfi.ApplyWindow(pixels, 41, 29, &parameters, null, film, 37, &window, IntPtr.Zero, result)
                            : RawFfi.ApplyWindow(pixels, 41, 29, &parameters, null, IntPtr.Zero, 0, &window, IntPtr.Zero, result));
                    Assert.Equal(Crop(full, x, y), actual);
                }
            }
        }
    }

    /// <summary>#3287: with the frame's haze map a dehazed window renders the
    /// same pixels the full frame does.</summary>
    [NativeFilmFact]
    public unsafe void DehazeWindowWithTheFrameHazeMapMatchesTheFullFrame()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var input = Enumerable.Range(0, 96 * 80).SelectMany(i => new[] {
            .05f + i % 96 / 170f, .12f + i / 96 / 250f, .23f, 1f }).ToArray();
        var model = new AdjustmentState { SharpenAmount = 0, NrColor = 0, Dehaze = 45 };
        var parameters = MapleAdjustmentParams.From(model, 6500, 0, 100, 0);
        fixed (float* source = input)
        {
            var full = new float[input.Length];
            fixed (float* output = full)
                Assert.Equal(0, RawFfi.maple_apply_chain_and_encode_display_curves_f32(source, 96, 80, &parameters, null, output));
            Assert.Equal(0, RawFfi.maple_scene_linear_chain_haze_map_f32(source, 96, 80, &parameters, null, out var haze));
            Assert.NotEqual(IntPtr.Zero, haze);
            try
            {
                var patch = Crop(input, 21, 27);
                var actual = new float[patch.Length];
                var window = new MapleChainWindow { X = 21, Y = 27, FullWidth = 96, FullHeight = 80 };
                fixed (float* pixels = patch)
                fixed (float* result = actual)
                {
                    Assert.Equal(8, RawFfi.ApplyWindow(pixels, 41, 29, &parameters, null, IntPtr.Zero, 0, &window, IntPtr.Zero, result));
                    Assert.Equal(0, RawFfi.ApplyWindow(pixels, 41, 29, &parameters, null, IntPtr.Zero, 0, &window, haze, result));
                }
                var expected = Crop(full, 21, 27);
                Assert.True(expected.Zip(actual).Max(p => Math.Abs(p.First - p.Second)) <= 1e-5f);
            }
            finally { RawFfi.maple_haze_map_free(haze); }
        }
    }

    private static float[] Crop(float[] input, int x, int y) => Enumerable.Range(y, 29)
        .SelectMany(row => input.Skip((row * 96 + x) * 4).Take(41 * 4)).ToArray();
}

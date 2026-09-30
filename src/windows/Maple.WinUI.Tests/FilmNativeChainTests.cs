using System.Runtime.CompilerServices;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class FilmNativeChainTests
{
    [NativeFilmFact]
    public unsafe void RetainedLatticeSupportsZeroStrengthSwitchingAndRejectsInvalidStrength()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        using var red = FilmLutHandle.Create(2, Enumerable.Range(0, 8).SelectMany(_ => new[] { .8f, .2f, .1f }).ToArray());
        using var blue = FilmLutHandle.Create(2, Enumerable.Range(0, 8).SelectMany(_ => new[] { .1f, .2f, .8f }).ToArray());
        var input = Enumerable.Range(0, 64).SelectMany(i => new[] { .03f + i / 100f, .12f, .27f, 1f }).ToArray();
        var baseline = new float[input.Length];
        var output = new float[input.Length];
        var parameters = MapleAdjustmentParams.From(new AdjustmentState(), 6500, 0, 100, 0);
        fixed (float* source = input)
        fixed (float* reference = baseline)
        fixed (float* result = output)
        {
            Assert.Equal(0, RawFfi.maple_apply_chain_and_encode_display_curves_f32(source, 8, 8, &parameters, null, reference));
            Assert.Equal(0, RawFfi.maple_apply_chain_and_encode_display_curves_film_f32(source, 8, 8, &parameters, null, red, 0, result));
            Assert.Equal(baseline, output);
            Assert.Equal(0, RawFfi.maple_apply_chain_and_encode_display_curves_film_f32(source, 8, 8, &parameters, null, red, 100, result));
            var redFrame = output.ToArray();
            Assert.False(baseline.SequenceEqual(redFrame));
            Assert.Equal(0, RawFfi.maple_apply_chain_and_encode_display_curves_film_f32(source, 8, 8, &parameters, null, blue, 100, result));
            Assert.False(redFrame.SequenceEqual(output));
            Assert.Equal(0, RawFfi.maple_apply_chain_and_encode_display_curves_film_f32(source, 8, 8, &parameters, null, red, 100, result));
            Assert.Equal(redFrame, output);
            foreach (var invalid in new[] { float.NaN, float.PositiveInfinity, -1f, 101f })
            {
                Array.Fill(output, -123f);
                Assert.NotEqual(0, RawFfi.maple_apply_chain_and_encode_display_curves_film_f32(source, 8, 8, &parameters, null, red, invalid, result));
                Assert.All(output, value => Assert.Equal(-123f, value));
            }
        }
        Assert.Throws<InvalidDataException>(() => FilmLutHandle.Create(1, new float[3]));
        Assert.Throws<InvalidDataException>(() => FilmLutHandle.Create(2, Enumerable.Repeat(float.NaN, 24).ToArray()));
    }
}

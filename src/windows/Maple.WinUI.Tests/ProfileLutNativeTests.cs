using System.Runtime.CompilerServices;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class ProfileLutNativeTests
{
    [NativeLutFact]
    public void ProductionCpuSamplerUsesAllSixTetrahedraAndPreservesAlpha()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var lut = new float[24];
        lut[21] = 1; lut[22] = 0.5f; lut[23] = 0.25f;
        foreach (var rgb in new[]
        {
            new[] { 0.8f, 0.5f, 0.2f }, new[] { 0.8f, 0.2f, 0.5f },
            new[] { 0.5f, 0.2f, 0.8f }, new[] { 0.5f, 0.8f, 0.2f },
            new[] { 0.2f, 0.8f, 0.5f }, new[] { 0.2f, 0.5f, 0.8f },
        })
        {
            var rgba = new[] { rgb[0], rgb[1], rgb[2], 0.37f };
            RenderEngine.ApplyDisplayLut(rgba, rgba.Length, lut, 2);
            Assert.Equal(new[] { 0.2f, 0.1f, 0.05f, 0.37f }, rgba);
        }
    }

    [NativeLutFact]
    public void InvalidGridFailsWithoutChangingPixels()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var rgba = new[] { 0.8f, 0.5f, 0.2f, 0.37f };
        var original = (float[])rgba.Clone();
        Assert.Throws<InvalidOperationException>(() =>
            RenderEngine.ApplyDisplayLut(rgba, rgba.Length, new float[23], 2));
        Assert.Equal(original, rgba);
    }

    [Fact]
    public void InvalidHostLengthsAreRejectedBeforeNativeMemoryAccess()
    {
        var rgba = new float[4];
        foreach (var count in new[] { -1, 3, 8 })
            Assert.Throws<ArgumentOutOfRangeException>(() =>
                RenderEngine.ApplyDisplayLut(rgba, count, new float[24], 2));
        RenderEngine.ApplyDisplayLut(rgba, 0, Array.Empty<float>(), 0);
    }

    private sealed class NativeLutFactAttribute : FactAttribute
    {
        public NativeLutFactAttribute()
        {
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
                Skip = "Requires the built shared-core DLL for production LUT sampling.";
        }
    }
}

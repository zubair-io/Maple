using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class DemosaicNativeFactAttribute : FactAttribute
{
    public DemosaicNativeFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL"))
            || string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_DEMOSAIC_TEST_RAW")))
            Skip = "Requires the native DLL and an explicit Bayer RAW fixture.";
    }
}

public class DemosaicNativeTests
{
    [DemosaicNativeFact]
    public void EveryCanonicalChoiceDecodesAndFitPreviewUsesTheFixedKernel()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var path = Environment.GetEnvironmentVariable("MAPLE_DEMOSAIC_TEST_RAW")!;
        Assert.True(File.Exists(path));
        var original = SHA256.HashData(File.ReadAllBytes(path));
        float[]? preview = null;
        foreach (var choice in Enum.GetNames<DemosaicChoice>())
        {
            var model = new AdjustmentState { Profile = ProfileMode.Neutral, Demosaic = choice };
            var fit = RenderEngine.Decode(path, model, 64, RefineDecodeQuality.Preview, IntPtr.Zero);
            Assert.Equal("bayer", fit.CameraSupport?.SensorLayout);
            if (preview == null) preview = fit.Pixels;
            else Assert.Equal(preview, fit.Pixels);
            var full = RenderEngine.Decode(path, model, 64, RefineDecodeQuality.Amaze, IntPtr.Zero);
            Assert.Equal("bayer", full.CameraSupport?.SensorLayout);
            Assert.True(full.Width >= fit.Width && full.Height >= fit.Height);
            Assert.All(full.Pixels, value => Assert.True(float.IsFinite(value)));
        }
        Assert.Equal(original, SHA256.HashData(File.ReadAllBytes(path)));
    }
}

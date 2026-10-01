using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class DefringeDecodeTests
{
    private static AdjustmentState Edited() => new()
    {
        Profile = ProfileMode.Neutral,
        DefringePurpleAmount = 20, DefringePurpleHueLo = 0, DefringePurpleHueHi = 100,
        DefringeGreenAmount = 20, DefringeGreenHueLo = 0, DefringeGreenHueHi = 100,
    };

    [Fact]
    public void DefringeBelongsOnlyToTheLiveChain()
    {
        var edited = Edited();
        var baseline = new AdjustmentState { Profile = ProfileMode.Neutral };
        var stripped = RenderEngine.StripChainStages(edited);
        Assert.Equal(0, stripped.DefringePurpleAmount);
        Assert.Equal(0, stripped.DefringeGreenAmount);
        Assert.Equal(baseline.DefringePurpleHueLo, stripped.DefringePurpleHueLo);
        Assert.Equal(baseline.DefringePurpleHueHi, stripped.DefringePurpleHueHi);
        Assert.Equal(baseline.DefringeGreenHueLo, stripped.DefringeGreenHueLo);
        Assert.Equal(baseline.DefringeGreenHueHi, stripped.DefringeGreenHueHi);
        Assert.False(RenderEngine.DecodeInputsChanged(baseline, edited));
        Assert.Equal(20, edited.DefringePurpleAmount);
        Assert.Equal(20, edited.DefringeGreenAmount);
    }

    [DefringeNativeFact]
    public async Task ReopeningDefringedPhotoKeepsFitAndNativeBasesUnmodified()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", "defringe.dng");
        var originalHash = SHA256.HashData(File.ReadAllBytes(path));
        var baseline = new AdjustmentState { Profile = ProfileMode.Neutral };
        var edited = Edited();
        var plain = RenderEngine.Decode(path, baseline, 64, RefineDecodeQuality.Preview, IntPtr.Zero);
        var reopened = RenderEngine.Decode(path, edited, 64, RefineDecodeQuality.Preview, IntPtr.Zero);
        Assert.Equal(plain.Pixels, reopened.Pixels);
        Assert.True(plain.Pixels.Chunk(4).Any(p => Math.Abs(p[0] - p[1]) > 0.1f), "Fixture must decode chromatic pixels.");
        await using var decoder = new NativeDetailDecoder();
        var geometry = await decoder.ReadGeometryAsync(path, baseline, default);
        var region = new NativeDetailRegion(geometry.CropWidth / 4, geometry.CropHeight / 4,
            Math.Min(64u, geometry.CropWidth / 2), Math.Min(64u, geometry.CropHeight / 2));
        var plainTile = await decoder.DecodeAsync(path, baseline, plain, region, default);
        var reopenedTile = await decoder.DecodeAsync(path, edited, reopened, region, default);
        Assert.Equal(plainTile.Image.Pixels, reopenedTile.Image.Pixels);
        var first = new byte[plain.Width * plain.Height * 4];
        var second = new byte[first.Length];
        var unedited = new byte[first.Length];
        float[]? scratch = null;
        RenderEngine.RenderTick(plain, baseline, ref scratch, unedited);
        RenderEngine.RenderTick(plain, edited, ref scratch, first);
        RenderEngine.RenderTick(reopened, edited, ref scratch, second);
        Assert.False(unedited.SequenceEqual(first), $"Fixture must exercise live defringe; scene {plain.Pixels.Min()}..{plain.Pixels.Max()}, output {unedited.Min()}..{unedited.Max()}, first {string.Join(',', unedited.Take(24))}.");
        Assert.Equal(first, second);
        Assert.Equal(originalHash, SHA256.HashData(File.ReadAllBytes(path)));
    }
}

public sealed class DefringeNativeFactAttribute : FactAttribute
{
    public DefringeNativeFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
            Skip = "Set MAPLE_RAW_FFI_DLL to exercise native defringe with the committed fixture.";
    }
}

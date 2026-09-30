using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class NativeDetailDecoderTests
{
    [DemosaicNativeFact]
    public async Task SliderChangesReuseTheMosaicAndFailedDecodeChangesCanBeRetried()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var source = Environment.GetEnvironmentVariable("MAPLE_DEMOSAIC_TEST_RAW")!;
        var path = Path.Combine(Path.GetTempPath(), $"maple-detail-retain-{Guid.NewGuid():N}{Path.GetExtension(source)}");
        File.Copy(source, path);
        try
        {
            var model = new AdjustmentState { Profile = ProfileMode.Neutral };
            var anchor = RenderEngine.Decode(path, model, 32, RefineDecodeQuality.Preview, IntPtr.Zero);
            await using var decoder = new NativeDetailDecoder();
            var geometry = await decoder.ReadGeometryAsync(path, model, default);
            var region = new NativeDetailRegion(0, 0, Math.Min(16u, geometry.CropWidth), Math.Min(16u, geometry.CropHeight));
            using (var exclusive = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None))
            {
                model.Exposure = 1.25;
                await decoder.DecodeAsync(path, model, anchor, region, default);
                model.Demosaic = nameof(DemosaicChoice.Rcd);
                await Assert.ThrowsAsync<InvalidDataException>(() => decoder.DecodeAsync(path, model, anchor, region, default));
            }
            var retried = await decoder.DecodeAsync(path, model, anchor, region, default);
            Assert.All(retried.Image.Pixels, value => Assert.True(float.IsFinite(value)));
        }
        finally { File.Delete(path); }
    }

    [DemosaicNativeFact]
    public async Task CroppedNativePatchRetainsFullFrameAnchorsAndCancellationDoesNotPoisonTheSession()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var path = Environment.GetEnvironmentVariable("MAPLE_DEMOSAIC_TEST_RAW")!;
        var hash = SHA256.HashData(File.ReadAllBytes(path));
        var model = new AdjustmentState { Profile = ProfileMode.Neutral };
        var anchor = RenderEngine.Decode(path, model, 32, RefineDecodeQuality.Preview, IntPtr.Zero);
        await using var decoder = new NativeDetailDecoder();
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => decoder.ReadGeometryAsync(path, model, cancelled.Token));
        var geometry = await decoder.ReadGeometryAsync(path, model, default);
        var region = new NativeDetailRegion(geometry.CropWidth / 4, geometry.CropHeight / 4,
            Math.Min(16u, geometry.CropWidth / 2), Math.Min(16u, geometry.CropHeight / 2));
        var patch = await decoder.DecodeAsync(path, model, anchor, region, default);
        Assert.Equal(region, patch.Region);
        Assert.Equal((int)region.Width, patch.Image.Width);
        Assert.Equal((int)region.Height, patch.Image.Height);
        Assert.Equal(anchor.AeGain, patch.Image.AeGain);
        Assert.Equal(anchor.WhitesAnchorEv, patch.Image.WhitesAnchorEv);
        Assert.Equal(anchor.DecodedTemperature, patch.Image.DecodedTemperature);
        Assert.Same(anchor.WbFrame, patch.Image.WbFrame);
        Assert.Same(anchor.NoiseProfile, patch.Image.NoiseProfile);
        Assert.All(patch.Image.Pixels, value => Assert.True(float.IsFinite(value)));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => decoder.DecodeAsync(path, model, anchor,
            new NativeDetailRegion(uint.MaxValue, 0, 16, 16), default));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => decoder.DecodeAsync(path, model, anchor,
            new NativeDetailRegion(0, 0, 16384, 16384), default));
        await decoder.DecodeAsync(path, model, anchor, region, default);
        await decoder.DisposeAsync();
        await Assert.ThrowsAsync<ObjectDisposedException>(() => decoder.ReadGeometryAsync(path, model, default));
        Assert.Equal(hash, SHA256.HashData(File.ReadAllBytes(path)));
    }
}

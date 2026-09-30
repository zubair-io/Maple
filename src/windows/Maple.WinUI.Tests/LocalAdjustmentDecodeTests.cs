using System.Runtime.CompilerServices;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class LocalAdjustmentDecodeTests
{
    [DemosaicNativeFact]
    public void ReopeningAMaskedPhotoDoesNotBakeTheLiveLayerIntoItsBase()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var path = Environment.GetEnvironmentVariable("MAPLE_DEMOSAIC_TEST_RAW")!;
        var plain = new AdjustmentState { Profile = ProfileMode.Neutral };
        var masked = plain.Clone();
        masked.LocalAdjustments.Add(new LocalAdjustment(
            new LinearMask(new MaskPoint(0, 0), new MaskPoint(1, 0), 0.5),
            new PartialAdjustments { Exposure = -3 }));
        var before = RenderEngine.Decode(path, plain, 64, RefineDecodeQuality.Preview, IntPtr.Zero);
        var reopened = RenderEngine.Decode(path, masked, 64, RefineDecodeQuality.Preview, IntPtr.Zero);
        Assert.True(before.Pixels.SequenceEqual(reopened.Pixels), "Saved masks must not be baked into the per-tick base.");
        var unedited = new byte[before.Width * before.Height * 4];
        var edited = new byte[unedited.Length];
        var reopenedEdited = new byte[unedited.Length];
        float[]? scratch = null;
        RenderEngine.RenderTick(before, plain, ref scratch, unedited);
        RenderEngine.RenderTick(before, masked, ref scratch, edited);
        RenderEngine.RenderTick(reopened, masked, ref scratch, reopenedEdited);
        Assert.False(unedited.SequenceEqual(edited), $"The live mask must visibly change the fixture; scene {before.Pixels.Min()}..{before.Pixels.Max()}, display {string.Join(',', unedited.Take(16))}.");
        Assert.Equal(edited, reopenedEdited);
        Assert.Single(masked.LocalAdjustments);
    }
}

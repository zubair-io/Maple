using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class WhitesAnchorHostTests
{
    [Theory]
    [InlineData(-3.25f)]
    [InlineData(1.375f)]
    public void CpuAndGpuParamsPreserveDecodedAnchor(float anchor)
    {
        var image = new DecodedImage
        {
            Pixels = new float[4], Width = 1, Height = 1,
            NoiseProfile = [], Iso = 100, AeGain = 1,
            WhitesAnchorEv = anchor,
            DecodedTemperature = 6500, DecodedTint = 0, WbFrame = new float[82],
        };
        var model = new AdjustmentState();
        var cpu = MapleAdjustmentParams.From(
            model, image.DecodedTemperature, image.DecodedTint, image.Iso, image.WhitesAnchorEv);
        var gpu = MapleGpuLiveParams.From(model, image);
        Assert.Equal(BitConverter.SingleToInt32Bits(anchor), BitConverter.SingleToInt32Bits(cpu.whites_anchor_ev));
        Assert.Equal(BitConverter.SingleToInt32Bits(anchor), BitConverter.SingleToInt32Bits(gpu.whites_anchor_ev));
        RawFfi.VerifyAbi();
    }
}

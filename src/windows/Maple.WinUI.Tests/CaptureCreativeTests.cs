using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed unsafe class CaptureCreativeTests
{
    private static CaptureCreative Creative(float aeGain) =>
        new(new MapleCaptureCreative { present = 1, ae_gain = aeGain });

    private static DecodedImage Image(CaptureCreative? creative) => new()
    {
        Pixels = new float[4], Width = 1, Height = 1, NoiseProfile = [], Iso = 100,
        AeGain = creative?.AeGain ?? 1, WhitesAnchorEv = 0, DecodedTemperature = 5200, DecodedTint = 4,
        Creative = creative,
    };

    [Fact]
    public void ARasterPinsToANullPointerSoTheChainKeepsTheWhiteBalanceDelta()
    {
        var image = Image(null);
        fixed (MapleCaptureCreative* pinned = image.Creative)
            Assert.True(pinned == null);
    }

    [Fact]
    public void ACaptureDecodePinsItsOwnCopyOfTheCreativeStage()
    {
        var creative = Creative(1.75f);
        fixed (MapleCaptureCreative* first = creative)
        fixed (MapleCaptureCreative* second = creative)
        {
            Assert.True(first != null);
            Assert.True(first == second);
            Assert.Equal(1u, first->present);
            Assert.Equal(1.75f, first->ae_gain);
        }
        Assert.Equal(1.75f, creative.AeGain);
    }

    [Fact]
    public void AStructThatIsNotACaptureDecodesIsRefused()
    {
        Assert.Throws<InvalidOperationException>(() => new CaptureCreative(new MapleCaptureCreative()));
        Assert.Throws<InvalidOperationException>(() => new CaptureCreative(new MapleCaptureCreative { present = 2 }));
    }

    [Fact]
    public void DerivedImagesShareTheDecodesCreativeStage()
    {
        var creative = Creative(1.25f);
        var half = RenderEngine.DownsampleHalf(new DecodedImage
        {
            Pixels = new float[16], Width = 2, Height = 2, NoiseProfile = [], Iso = 100,
            AeGain = 1.25f, WhitesAnchorEv = 0, DecodedTemperature = 5200, DecodedTint = 4,
            Creative = creative,
        });
        Assert.Same(creative, half.Creative);
        Assert.Equal(5200f, half.DecodedTemperature);
    }

    [Fact]
    public void ParamsAreAbsoluteAndPointingThemAtTheCreativeStageAllocatesNothing()
    {
        var model = new AdjustmentState { Temperature = 3100, Tint = -12 };
        var image = Image(Creative(1.5f));
        Tick(model, image);
        var before = GC.GetAllocatedBytesForCurrentThread();
        var (gpu, cpu) = Tick(model, image);
        Assert.Equal(0, GC.GetAllocatedBytesForCurrentThread() - before);
        Assert.Equal(3100f, gpu.temperature);
        Assert.Equal(-12f, gpu.tint);
        Assert.Equal(3100f, cpu.temperature);
        Assert.Equal(-12f, cpu.tint);
        Assert.Equal(0u, gpu.wb_hsm_len);
        Assert.True(gpu.wb_hsm_ptr == null && cpu.wb_hsm_ptr == null);
        Assert.Equal(0f, gpu.wb_frame_scene_cct);
    }

    private static (MapleGpuLiveParams Gpu, MapleAdjustmentParams Cpu) Tick(AdjustmentState model, DecodedImage image)
    {
        var gpu = MapleGpuLiveParams.From(model, image);
        var cpu = MapleAdjustmentParams.From(model, image.DecodedTemperature, image.DecodedTint, image.Iso,
            image.WhitesAnchorEv, image.NrSamplingScale);
        fixed (MapleCaptureCreative* creative = image.Creative)
        {
            gpu.creative_ptr = creative;
            cpu.creative_ptr = creative;
            Assert.True(gpu.creative_ptr == cpu.creative_ptr && creative != null);
        }
        return (gpu, cpu);
    }
}

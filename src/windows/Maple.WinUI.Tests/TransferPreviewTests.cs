using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Transfer;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class TransferPreviewTests
{
    [Fact]
    public void PreviewShowsActualMixedValuesAndChangedPhotoCounts()
    {
        var targets = new[]
        {
            new TransferPreviewTarget("a", "a.dng", new XmpSidecarDocument { Adjustments = new() { Exposure = 0, Contrast = 7 } }, null),
            new TransferPreviewTarget("b", "b.dng", new XmpSidecarDocument { Adjustments = new() { Exposure = 1, Contrast = 7 } }, null)
        };
        var result = TransferPreview.Build(new(new AdjustmentState { Exposure = 1 }, 5, null), new[] { "tone" }, targets, false);
        var fields = Assert.Single(result.Groups).Fields;
        var exposure = fields.Single(f => f.Name == "exposure");
        Assert.Equal("Mixed: 0; 1", exposure.Current);
        Assert.Equal("1", exposure.Incoming);
        Assert.Equal(1, exposure.ChangedPhotos);
        Assert.Equal(2, fields.Single(f => f.Name == "contrast").ChangedPhotos);
        Assert.Equal(0, targets[0].Document.Adjustments.Exposure);
    }

    [Fact]
    public void RelativePreviewShowsPerCameraIncomingValuesAndDoesNotClampCurrentValues()
    {
        var targets = new[]
        {
            new TransferPreviewTarget("a", "a", new XmpSidecarDocument { Adjustments = new() { Temperature = 15000 } }, new(4000, 0)),
            new TransferPreviewTarget("b", "b", new XmpSidecarDocument(), new(5000, 10))
        };
        var source = new AdjustmentState { Temperature = 6500, WbSource = WbSource.Manual };
        var preview = TransferPreview.Build(new(source, 5, new(6000, 0)), new[] { "white_balance" }, targets, true);
        var field = preview.Groups.Single().Fields.Single(f => f.Name == "temperature");
        Assert.Equal("Mixed: 15000; 6500", field.Current);
        Assert.Equal("Mixed: 4500; 5500", field.Incoming);
        Assert.Equal(2, field.ChangedPhotos);
    }
}

using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class AutoProfileStatusTests
{
    [Theory]
    [InlineData(0, AutoProfileOutcome.Applied)]
    [InlineData(10, AutoProfileOutcome.NoPreview)]
    [InlineData(1, AutoProfileOutcome.Unavailable)]
    [InlineData(-1, AutoProfileOutcome.Unavailable)]
    [InlineData(-2, AutoProfileOutcome.Unavailable)]
    [InlineData(6, AutoProfileOutcome.Unavailable)]
    [InlineData(7, AutoProfileOutcome.Unavailable)]
    [InlineData(99, AutoProfileOutcome.Unavailable)]
    public void ClassifiesTheNativeFitReturnCode(int rc, AutoProfileOutcome expected) =>
        Assert.Equal(expected, AutoProfileStatus.Classify(rc));

    [Fact]
    public void NoPreviewCodeMirrorsRawFfi() => Assert.Equal(10, RawFfi.MapleAutoFitNoPreview);

    [Fact]
    public void NoPreviewFallbackShowsTheVisibleNeutralLine()
    {
        Assert.Equal("Auto unavailable: no camera preview — showing Neutral.",
            AutoProfileStatus.VisibleLine(ProfileMode.Auto, AutoProfileOutcome.NoPreview));
        Assert.Equal(AutoProfileStatus.NoPreviewText,
            AutoProfileStatus.Describe(ProfileMode.Auto, AutoProfileOutcome.NoPreview));
    }

    [Fact]
    public void AppliedAndUnavailableUseTheSharedCopyWithoutAVisibleLine()
    {
        Assert.Equal("Color and contrast matched to this image’s embedded camera preview.",
            AutoProfileStatus.Describe(ProfileMode.Auto, AutoProfileOutcome.Applied));
        Assert.Equal("Auto matching is unavailable for this image; camera-preview matching was not applied.",
            AutoProfileStatus.Describe(ProfileMode.Auto, AutoProfileOutcome.Unavailable));
        Assert.Empty(AutoProfileStatus.VisibleLine(ProfileMode.Auto, AutoProfileOutcome.Applied));
        Assert.Empty(AutoProfileStatus.VisibleLine(ProfileMode.Auto, AutoProfileOutcome.Unavailable));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(AutoProfileOutcome.Applied)]
    [InlineData(AutoProfileOutcome.NoPreview)]
    [InlineData(AutoProfileOutcome.Unavailable)]
    public void NeutralNeverDescribesAnAutoOutcome(AutoProfileOutcome? outcome)
    {
        Assert.Empty(AutoProfileStatus.Describe(ProfileMode.Neutral, outcome));
        Assert.Empty(AutoProfileStatus.VisibleLine(ProfileMode.Neutral, outcome));
    }

    [Fact]
    public void PendingDecodeDescribesNothing() =>
        Assert.Empty(AutoProfileStatus.Describe(ProfileMode.Auto, null));

    [Fact]
    public void PublishForTheCurrentGenerationSetsTheOutcome()
    {
        var state = default(AutoProfileStatusState).Begin(4, keepOutcome: false)
            .Publish(4, AutoProfileOutcome.NoPreview);
        Assert.Equal(AutoProfileOutcome.NoPreview, state.Outcome);
    }

    [Fact]
    public void ResultFromAnOlderPhotoOrProfileDecodeIsIgnored()
    {
        var current = default(AutoProfileStatusState).Begin(4, keepOutcome: false)
            .Publish(4, AutoProfileOutcome.NoPreview)
            .Begin(5, keepOutcome: false);
        var afterStale = current.Publish(4, AutoProfileOutcome.Applied);
        Assert.Equal(current, afterStale);
        Assert.Null(afterStale.Outcome);
        Assert.Equal(AutoProfileOutcome.Applied, afterStale.Publish(5, AutoProfileOutcome.Applied).Outcome);
    }

    [Fact]
    public void PhotoOrProfileChangeClearsTheOutcome()
    {
        var landed = new AutoProfileStatusState(7, AutoProfileOutcome.NoPreview);
        Assert.Null(landed.Begin(8, keepOutcome: false).Outcome);
    }

    [Fact]
    public void RepairOnlyRedecodeKeepsTheOutcomeUntilItsOwnResultLands()
    {
        var landed = new AutoProfileStatusState(7, AutoProfileOutcome.NoPreview);
        var repairing = landed.Begin(8, keepOutcome: true);
        Assert.Equal(AutoProfileOutcome.NoPreview, repairing.Outcome);
        Assert.Equal(repairing, repairing.Publish(7, AutoProfileOutcome.Applied));
        Assert.Equal(AutoProfileOutcome.Applied, repairing.Publish(8, AutoProfileOutcome.Applied).Outcome);
    }
}

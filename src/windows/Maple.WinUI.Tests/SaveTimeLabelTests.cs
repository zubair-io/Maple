using System;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class SaveTimeLabelTests
{
    [Theory]
    [InlineData(0, " · Saved just now")]
    [InlineData(59, " · Saved just now")]
    [InlineData(60, " · Saved 1m ago")]
    [InlineData(3600, " · Saved 1h ago")]
    [InlineData(86400, " · Saved 1d ago")]
    public void UsesElapsedTimeRatherThanOriginalFileTime(int seconds, string expected)
    {
        var now = DateTimeOffset.Parse("2026-10-01T12:00:00Z");
        Assert.Equal(expected, SaveTimeLabel.Format(now.AddSeconds(-seconds), now));
    }

    [Fact]
    public void UnknownTimeIsOmittedAndFutureTimeIsNotReportedAsJustSaved()
    {
        var now = DateTimeOffset.UtcNow;
        Assert.Equal(string.Empty, SaveTimeLabel.Format(null, now));
        Assert.Equal($" · Saved {now.AddHours(1).ToLocalTime():g}",
            SaveTimeLabel.Format(now.AddHours(1), now));
    }
}

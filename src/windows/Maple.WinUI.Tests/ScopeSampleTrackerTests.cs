using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class ScopeSampleTrackerTests
{
    [Fact]
    public void Edits_reject_old_samples_without_resetting_native_frame_numbers()
    {
        var tracker = new ScopeSampleTracker();
        tracker.SetEnabled(true);
        tracker.Submitted();
        tracker.Invalidate();
        Assert.False(tracker.TryAccept(1, out _));
        tracker.Submitted();
        Assert.True(tracker.TryAccept(2, out var version));
        Assert.True(tracker.IsCurrent(version));
        tracker.Invalidate();
        Assert.False(tracker.IsCurrent(version));
    }

    [Fact]
    public void Closed_scopes_and_replaced_images_reject_inflight_publication()
    {
        var tracker = new ScopeSampleTracker();
        tracker.SetEnabled(true);
        tracker.Submitted();
        var oldVersion = tracker.Version;
        tracker.SetEnabled(false);
        Assert.False(tracker.TryAccept(1, out _));
        Assert.False(tracker.IsCurrent(oldVersion));
        tracker.SetEnabled(true);
        tracker.Submitted();
        Assert.True(tracker.TryAccept(2, out _));
        tracker.ResetSession();
        tracker.Submitted();
        Assert.True(tracker.TryAccept(1, out var newVersion));
        Assert.NotEqual(oldVersion, newVersion);
    }

    [Fact]
    public void Newest_completed_frame_cannot_be_overwritten_by_an_older_or_duplicate_frame()
    {
        var tracker = new ScopeSampleTracker();
        tracker.SetEnabled(true);
        tracker.Submitted(); tracker.Submitted();
        Assert.True(tracker.TryAccept(2, out _));
        Assert.False(tracker.TryAccept(1, out _));
        Assert.False(tracker.TryAccept(2, out _));
        for (var i = 0; i < 1000; i++) tracker.Submitted();
        Assert.False(tracker.TryAccept(3, out _));
        Assert.True(tracker.TryAccept(1002, out _));
    }
}

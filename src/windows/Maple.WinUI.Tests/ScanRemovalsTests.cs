using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class ScanRemovalsTests
{
    private static List<PhotoItem> Photos(params string[] paths) => paths.Select(p => new PhotoItem { FilePath = p }).ToList();

    private static string[] Paths(List<PhotoItem> items) => items.Select(i => i.FilePath).ToArray();

    [Fact]
    public void A_photo_removed_after_the_scan_began_is_left_out_of_its_results()
    {
        var removals = new ScanRemovals();
        var scan = removals.Begin();

        removals.Removed(@"C:\Trip\b.dng");

        Assert.Equal(new[] { @"C:\Trip\a.dng", @"C:\Trip\c.dng" },
            Paths(scan.Surviving(Photos(@"C:\Trip\a.dng", @"C:\Trip\b.dng", @"C:\Trip\c.dng"))));
    }

    [Fact]
    public void A_removal_reported_before_the_scan_began_is_not_held_against_it()
    {
        var removals = new ScanRemovals();
        removals.Removed(@"C:\Trip\b.dng");

        var scan = removals.Begin();

        Assert.Equal(2, scan.Surviving(Photos(@"C:\Trip\a.dng", @"C:\Trip\b.dng")).Count);
    }

    [Fact]
    public void A_photo_deleted_and_created_again_during_the_scan_is_present()
    {
        var removals = new ScanRemovals();
        var scan = removals.Begin();

        removals.Removed(@"C:\Trip\b.dng");
        removals.Present(@"C:\Trip\b.dng");

        Assert.Equal(new[] { @"C:\Trip\b.dng" }, Paths(scan.Surviving(Photos(@"C:\Trip\b.dng"))));
    }

    [Fact]
    public void Paths_compare_without_regard_to_case()
    {
        var removals = new ScanRemovals();
        var scan = removals.Begin();

        removals.Removed(@"c:\trip\B.DNG");

        Assert.Empty(scan.Surviving(Photos(@"C:\Trip\b.dng")));
    }

    [Fact]
    public void An_ended_scan_stops_collecting()
    {
        var removals = new ScanRemovals();
        var ended = removals.Begin();
        ended.End();
        var current = removals.Begin();

        removals.Removed(@"C:\Trip\b.dng");

        Assert.Equal(1, ended.Surviving(Photos(@"C:\Trip\b.dng")).Count);
        Assert.Empty(current.Surviving(Photos(@"C:\Trip\b.dng")));
    }
}

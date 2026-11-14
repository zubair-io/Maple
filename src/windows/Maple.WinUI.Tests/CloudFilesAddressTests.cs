using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.CloudFiles;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudFilesAddressTests
{
    private static CloudFolder Folder(string id, string slug, string path) =>
        new() { Id = id, Slug = slug, Path = path };

    [Fact]
    public void ResolvesStableRootAndNestedAddressesWithoutLosingColons()
    {
        var folders = new[] { Folder("one", "library", "/srv/photos") };

        Assert.True(CloudFilesAddress.TryResolve("library:", folders, out var root));
        Assert.Equal(new ResolvedCloudFilesAddress("library:", "one", ""), root);

        Assert.True(CloudFilesAddress.TryResolve("library:2026/My Photo/IMG:01.dng", folders, out var nested));
        Assert.Equal("library:2026/My Photo/IMG:01.dng", nested.Address);
        Assert.Equal("2026/My Photo/IMG:01.dng", nested.RelativePath);
        Assert.Equal("one", nested.FolderId);
    }

    [Fact]
    public void ResolvesLegacyAbsolutePathAgainstTheLongestRegisteredRoot()
    {
        var folders = new[]
        {
            Folder("parent", "photos", "/srv/photos"),
            Folder("child", "event", "/srv/photos/event"),
        };

        Assert.True(CloudFilesAddress.TryResolve("/srv/photos/event/day 1/IMG_1.dng", folders, out var resolved));
        Assert.Equal(new ResolvedCloudFilesAddress("event:day 1/IMG_1.dng", "child", "day 1/IMG_1.dng"), resolved);
    }

    [Fact]
    public void ResolvesWindowsStyleLegacyPathsAndLibraryRoot()
    {
        var folders = new[] { Folder("win", "camera-roll", "C:\\Media\\Photos") };
        Assert.True(CloudFilesAddress.TryResolve("C:\\Media\\Photos\\2026\\one.mp4", folders, out var nested));
        Assert.Equal("camera-roll:2026/one.mp4", nested.Address);
        Assert.Equal("2026/one.mp4", nested.RelativePath);
        Assert.True(CloudFilesAddress.TryResolve("C:\\Media\\Photos", folders, out var root));
        Assert.Equal("camera-roll:", root.Address);
    }

    [Theory]
    [InlineData("missing:photo.dng")]
    [InlineData("library:../outside.dng")]
    [InlineData("library:a/../../outside.dng")]
    [InlineData("/srv/other/photo.dng")]
    public void RejectsUnknownOrEscapingIdentities(string identity)
    {
        Assert.False(CloudFilesAddress.TryResolve(
            identity, new[] { Folder("one", "library", "/srv/photos") }, out _));
    }

    [Fact]
    public void MapsEveryUnifiedEntryClassToStablePlaceholderIdentityAndMetadata()
    {
        var listing = new CloudFolderListing
        {
            Folders = [Entry("2026", "library:2026", 99, "2026-01-02T03:04:05Z")],
            Images = [Entry("IMG_1.DNG", "library:2026/IMG_1.DNG", 1234, "2026-01-02T03:04:05Z")],
            Files = [Entry("movie.mov", "library:2026/movie.mov", 5678, "2026-01-02T03:04:05Z")],
            Sidecars = [Entry("IMG_1.DNG.xmp", "library:2026/IMG_1.DNG.xmp", 64, "2026-01-02T03:04:05Z")],
        };

        var mapped = CloudFilesAddress.MapListing(listing);
        Assert.Equal(new[] { "2026", "IMG_1.DNG", "IMG_1.DNG.xmp", "movie.mov" }, mapped.Select(e => e.Name));
        Assert.Equal("library:2026/IMG_1.DNG.xmp", mapped.Single(e => e.Name.EndsWith(".xmp")).Address);
        Assert.True(mapped.Single(e => e.Name == "2026").IsDirectory);
        Assert.Equal(0, mapped.Single(e => e.Name == "2026").Size);
        Assert.False(mapped.Single(e => e.Name == "movie.mov").IsDirectory);
        Assert.Equal(5678, mapped.Single(e => e.Name == "movie.mov").Size);
        Assert.Equal(DateTimeKind.Utc, mapped.Single(e => e.Name == "IMG_1.DNG").MtimeUtc.Kind);
    }

    private static CloudFolderEntry Entry(string name, string address, long size, string mtime) =>
        new() { Name = name, Address = address, Path = "/srv/photos/" + name, Size = size, Mtime = mtime };
}

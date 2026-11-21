using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.CloudFiles;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudChangeFeedTests
{
    [Fact]
    public void CursorIsPersistedPerServerAndSurvivesReopen()
    {
        var root = Path.Combine(Path.GetTempPath(), "maple-cloud-cursor-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var first = new CloudChangeCursorStore("https://maple.example/", "user-a", root);
            Assert.Equal(0, first.Read());
            first.Write(42);
            Assert.Equal(42, new CloudChangeCursorStore("https://maple.example", "user-a", root).Read());
            Assert.Equal(0, new CloudChangeCursorStore("https://other.example", "user-a", root).Read());
            Assert.Equal(0, new CloudChangeCursorStore("https://maple.example", "user-b", root).Read());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public void PlannerMapsCreatesUpdatesAndSidecarRowsToParentRefresh()
    {
        var actions = CloudChangePlanner.Plan(new[]
        {
            new CloudAssetChange { Cursor = 2, FolderId = "f", Kind = "create", RelativePath = "2026/new.dng" },
            new CloudAssetChange { Cursor = 3, FolderId = "f", Kind = "update", RelativePath = "2026/new.dng.xmp" },
            new CloudAssetChange { Cursor = 4, FolderId = "f", Kind = "restore", RelativePath = "2026/restored.dng" },
        });
        Assert.Equal(3, actions.Count);
        Assert.All(actions, a => Assert.Equal(CloudChangeActionKind.RefreshDirectory, a.Kind));
        Assert.Equal("2026/new.dng", actions[0].RelativePath);
        Assert.Equal("2026/new.dng.xmp", actions[1].RelativePath);
        Assert.Equal("2026/restored.dng", actions[2].RelativePath);
    }

    [Fact]
    public void PlannerFlagsDeletesAndRejectsUnsafeOrUnresolvableRows()
    {
        var actions = CloudChangePlanner.Plan(new[]
        {
            new CloudAssetChange { Cursor = 1, FolderId = "f", Kind = "delete", RelativePath = "a.dng" },
            new CloudAssetChange { Cursor = 2, FolderId = "f", Kind = "delete", RelativePath = "../outside" },
            new CloudAssetChange { Cursor = 3, FolderId = null, Kind = "update", RelativePath = "a.dng" },
        });
        var action = Assert.Single(actions);
        Assert.Equal(CloudChangeActionKind.DeleteIfInSync, action.Kind);
        Assert.Equal("a.dng", action.RelativePath);
    }

    [Fact]
    public void PathGuardAcceptsDescendantsAndRejectsSiblingPrefix()
    {
        var root = Path.Combine(Path.GetTempPath(), "Maple Cloud");
        Assert.True(CloudFilesChangeApply.IsWithin(root, root));
        Assert.True(CloudFilesChangeApply.IsWithin(root, root + Path.DirectorySeparatorChar));
        Assert.True(CloudFilesChangeApply.IsWithin(root, Path.Combine(root, "library", "a.dng")));
        Assert.False(CloudFilesChangeApply.IsWithin(root, root + "-backup"));
    }

    [Fact]
    public void MetadataMatchAvoidsUnnecessaryPlaceholderRewrites()
    {
        using var temp = new TempDirectory();
        var path = System.IO.Path.Combine(temp.Path, "same.bin");
        File.WriteAllBytes(path, new byte[] { 1, 2, 3 });
        var modified = new DateTime(2025, 4, 5, 6, 7, 8, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(path, modified);
        var entry = new PlaceholderEntry("same.bin", "folder:same.bin", false, 3, modified);
        Assert.True(CloudFilesChangeApply.MetadataMatches(path, entry));
        Assert.False(CloudFilesChangeApply.MetadataMatches(path, entry with { Size = 4 }));
        Assert.False(CloudFilesChangeApply.MetadataMatches(path, entry with { MtimeUtc = modified.AddSeconds(1) }));
    }

    [Fact]
    public void PopulatedDirectoryMatchesWhateverItsLocalMtime()
    {
        using var temp = new TempDirectory();
        var path = System.IO.Path.Combine(temp.Path, "2026");
        Directory.CreateDirectory(path);
        var entry = new PlaceholderEntry("2026", "folder:2026", true, 0, new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        Assert.True(CloudFilesChangeApply.MetadataMatches(path, entry));
        Assert.False(CloudFilesChangeApply.MetadataMatches(path, entry with { IsDirectory = false }));
    }

    [Fact]
    public async Task ClientReadsChangePageFromServerContract()
    {
        using var temp = new TempDirectory();
        var handler = new ResponseHandler(HttpStatusCode.OK,
            "{\"changes\":[{\"cursor\":7,\"asset_id\":\"a\",\"folder_id\":\"f\",\"kind\":\"update\",\"abs_path\":\"/srv/a.dng\",\"relative_path\":\"a.dng.xmp\",\"at\":\"2026-01-01T00:00:00Z\"}],\"next_cursor\":7}");
        using var client = new CloudClient("https://maple.example", handler, temp.Path);
        var page = await client.ListChangesAsync(6, 100, CancellationToken.None);
        Assert.Equal("/api/changes?since=6&limit=100", handler.LastRequest!.RequestUri!.PathAndQuery);
        Assert.Equal(7, page!.NextCursor);
        Assert.Equal("a.dng.xmp", Assert.Single(page.Changes).RelativePath);
    }

    [Fact]
    public async Task ClientExposesCurrentCursorOn409()
    {
        using var temp = new TempDirectory();
        using var client = new CloudClient("https://maple.example",
            new ResponseHandler(HttpStatusCode.Conflict, "{\"error\":\"cursor too old\",\"current\":91}"), temp.Path);
        var error = await Assert.ThrowsAsync<CloudChangeCursorExpiredException>(
            () => client.ListChangesAsync(3, 100, CancellationToken.None));
        Assert.Equal(91, error.Current);
    }

    private sealed class ResponseHandler(HttpStatusCode status, string body) : HttpMessageHandler
    {
        internal HttpRequestMessage? LastRequest { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            LastRequest = request;
            return Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class TempDirectory : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "maple-change-test-" + Guid.NewGuid().ToString("N"));
        internal TempDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}

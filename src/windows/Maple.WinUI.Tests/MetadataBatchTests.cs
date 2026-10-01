using System.Net;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class WindowsFileSharingFactAttribute : FactAttribute
{
    public WindowsFileSharingFactAttribute()
    {
        if (!OperatingSystem.IsWindows()) Skip = "Requires Windows delete-sharing enforcement.";
    }
}

public sealed class MetadataBatchTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "maple-batch-metadata-" + Guid.NewGuid().ToString("N"));
    public MetadataBatchTests() => Directory.CreateDirectory(_directory);
    public void Dispose() => Directory.Delete(_directory, true);

    private MetadataBatchItem Item(string name)
    {
        var path = Path.Combine(_directory, name + ".dng");
        File.WriteAllBytes(path, new byte[] { 0, 2, 4, 8 });
        return new(new(path, name), new(0, "none", null, Array.Empty<string>()));
    }

    [Fact]
    public async Task RetryDoesNotRewriteSuccessfulItems()
    {
        var first = Item("first");
        var second = Item("second");
        File.WriteAllText(SidecarStore.SidecarPathFor(second.Target.Path), "<broken");
        var batch = new MetadataBatch(new[] { first, second }, new(Rating: 2), null);
        await batch.ApplyAsync(CancellationToken.None);
        Assert.NotNull(first.Saved);
        Assert.Null(second.Saved);
        Assert.NotNull(second.Error);
        SidecarStore.Update(first.Target.Path, doc => doc.Rating = 5);
        SidecarStore.Save(second.Target.Path, new());
        await batch.ApplyAsync(CancellationToken.None);
        Assert.Equal(5, SidecarStore.Load(first.Target.Path)!.Rating);
        Assert.Equal(2, SidecarStore.Load(second.Target.Path)!.Rating);
        Assert.Null(second.Error);
        Assert.Equal(new byte[] { 0, 2, 4, 8 }, File.ReadAllBytes(first.Target.Path));
        Assert.Equal(new byte[] { 0, 2, 4, 8 }, File.ReadAllBytes(second.Target.Path));
    }

    [WindowsFileSharingFact]
    public async Task LockedSidecarIsNotReportedSavedAndRetryPreservesOriginal()
    {
        var item = Item("locked");
        SidecarStore.Save(item.Target.Path, new() { Rating = 1, Flag = "none" });
        var sidecar = SidecarStore.SidecarPathFor(item.Target.Path);
        var before = File.ReadAllBytes(sidecar);
        var original = File.ReadAllBytes(item.Target.Path);
        var batch = new MetadataBatch(new[] { item }, new(Rating: 4, Flag: "pick"), null);
        var reports = new List<bool>();
        // Allow the metadata read, but deny the atomic replacement while a
        // different application holds the sidecar without delete sharing.
        using (var held = new FileStream(sidecar, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            await batch.ApplyAsync(CancellationToken.None,
                new ImmediateProgress(result => reports.Add(result.Saved != null)));
            Assert.Null(item.Saved);
            Assert.NotNull(item.Error);
            Assert.Equal(before, File.ReadAllBytes(sidecar));
            Assert.Empty(Directory.GetFiles(_directory, "*.tmp"));
        }
        Assert.Equal(new[] { false }, reports);
        await batch.ApplyAsync(CancellationToken.None);
        Assert.Null(item.Error);
        Assert.Equal(4, item.Saved!.Rating);
        Assert.Equal("pick", item.Saved.Flag);
        var persisted = await MetadataBatch.ReadAsync(item.Target, null, CancellationToken.None);
        Assert.Equal(4, persisted.Rating);
        Assert.Equal("pick", persisted.Flag);
        Assert.Equal(original, File.ReadAllBytes(item.Target.Path));
    }

    [Fact]
    public async Task CancelFinishesCurrentWriteAndLeavesRemainingPending()
    {
        var first = Item("first");
        var second = Item("second");
        using var cancellation = new CancellationTokenSource();
        var batch = new MetadataBatch(new[] { first, second }, new(Rating: 3), null);
        await batch.ApplyAsync(cancellation.Token, new ImmediateProgress(_ => cancellation.Cancel()));
        Assert.NotNull(first.Saved);
        Assert.Null(second.Saved);
        Assert.False(File.Exists(SidecarStore.SidecarPathFor(second.Target.Path)));
        await batch.ApplyAsync(CancellationToken.None);
        Assert.NotNull(second.Saved);
    }

    [Fact]
    public async Task CloudMultiStatusFailureIsNotAnAcknowledgedSave()
    {
        using var client = new CloudClient("https://maple.example.test", new ReplyHandler(HttpStatusCode.MultiStatus,
            """{"results":[{"address":"photos:a.dng","ok":false,"error":"Read-only library"}]}"""), _directory);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => client.WriteMetadataAsync(
            "photos:a.dng", new Dictionary<string, object?> { ["rating"] = 4 }, CancellationToken.None));
        Assert.Contains("Read-only", error.Message);
    }

    [Fact]
    public async Task CloudPermissionFailureIsNotAnAbsentSidecar()
    {
        using var client = new CloudClient("https://maple.example.test", new ReplyHandler(HttpStatusCode.Forbidden, ""), _directory);
        await Assert.ThrowsAsync<HttpRequestException>(() => client.ReadMetadataXmpAsync("/photos/a.dng", CancellationToken.None));
    }

    private sealed class ImmediateProgress(Action<MetadataBatchItem> report) : IProgress<MetadataBatchItem>
    {
        public void Report(MetadataBatchItem value) => report(value);
    }

    private sealed class ReplyHandler(HttpStatusCode status, string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) });
    }
}

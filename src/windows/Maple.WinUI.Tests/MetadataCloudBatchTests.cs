using System.Net;
using System.Text.Json;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class MetadataCloudBatchTests : IDisposable
{
    private readonly string _cache = Path.Combine(Path.GetTempPath(), "maple-metadata-cloud-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_cache)) Directory.Delete(_cache, true); }

    private static MetadataBatchItem Item(string name) => new(
        new("/photos/" + name + ".dng", name, "photos:" + name + ".dng"),
        new(0, "none", null, Array.Empty<string>()));

    [Fact]
    public async Task CancelAfterDispatchRetainsAcknowledgementAndRetrySkipsSavedPhoto()
    {
        using var handler = new MetadataHandler { PauseFirstPost = true };
        using var cloud = new CloudClient("https://maple.example.test", handler, _cache);
        using var cancellation = new CancellationTokenSource();
        var first = Item("first");
        var second = Item("second");
        var batch = new MetadataBatch(new[] { first, second }, new(Rating: 4), cloud);
        var reports = new List<MetadataBatchItem>();
        var apply = batch.ApplyAsync(cancellation.Token, new InlineProgress(reports.Add));
        await handler.PostStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        Assert.Null(first.Saved);
        Assert.False(apply.IsCompleted);
        handler.ReleasePost.SetResult();
        await apply.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(4, first.Saved!.Rating);
        Assert.Null(first.Error);
        Assert.Null(second.Saved);
        Assert.Null(second.Error);
        Assert.Equal(new[] { first }, reports);
        Assert.Equal(new[] { "/photos/first.dng" }, handler.Reads);
        Assert.Equal(new[] { "photos:first.dng" }, handler.Writes);

        await batch.ApplyAsync(CancellationToken.None, new InlineProgress(reports.Add));
        Assert.Equal(4, second.Saved!.Rating);
        Assert.Equal(new[] { first, second }, reports);
        Assert.Equal(new[] { "/photos/first.dng", "/photos/second.dng" }, handler.Reads);
        Assert.Equal(new[] { "photos:first.dng", "photos:second.dng" }, handler.Writes);
    }

    [Fact]
    public async Task RejectedCloudItemRemainsUnfinishedAndCanBeRetried()
    {
        using var handler = new MetadataHandler { RejectFirstPost = true };
        using var cloud = new CloudClient("https://maple.example.test", handler, _cache);
        var item = Item("first");
        var batch = new MetadataBatch(new[] { item }, new(Rating: 4), cloud);
        await batch.ApplyAsync(CancellationToken.None);
        Assert.Null(item.Saved);
        Assert.Contains("Read-only library", item.Error);
        await batch.ApplyAsync(CancellationToken.None);
        Assert.Equal(4, item.Saved!.Rating);
        Assert.Null(item.Error);
        Assert.Equal(new[] { "photos:first.dng", "photos:first.dng" }, handler.Writes);
    }

    private sealed class InlineProgress(Action<MetadataBatchItem> report) : IProgress<MetadataBatchItem>
    {
        public void Report(MetadataBatchItem item) => report(item);
    }

    private sealed class MetadataHandler : HttpMessageHandler
    {
        public bool PauseFirstPost { get; init; }
        public bool RejectFirstPost { get; init; }
        public TaskCompletionSource PostStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ReleasePost { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public List<string> Reads { get; } = new();
        public List<string> Writes { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Get)
            {
                Assert.Equal("/api/xmp", request.RequestUri!.AbsolutePath);
                Reads.Add(Uri.UnescapeDataString(request.RequestUri.Query[6..]));
                return new(HttpStatusCode.OK) { Content = new StringContent(XmpWriter.Serialize(new())) };
            }
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal("/api/xmp/batch", request.RequestUri!.AbsolutePath);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            var entry = Assert.Single(body.RootElement.GetProperty("entries").EnumerateArray());
            var address = entry.GetProperty("address").GetString()!;
            Assert.Equal(4, entry.GetProperty("metadata").GetProperty("rating").GetInt32());
            Writes.Add(address);
            if (Writes.Count == 1 && PauseFirstPost)
            {
                PostStarted.SetResult();
                await ReleasePost.Task.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken);
            }
            var rejected = Writes.Count == 1 && RejectFirstPost;
            return new(HttpStatusCode.MultiStatus) { Content = new StringContent(JsonSerializer.Serialize(
                new { results = new[] { new { address, ok = !rejected, error = rejected ? "Read-only library" : null } } })) };
        }
    }
}

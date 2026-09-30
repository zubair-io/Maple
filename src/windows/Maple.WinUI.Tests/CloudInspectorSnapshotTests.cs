using System.Net;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudInspectorSnapshotTests : IDisposable
{
    private readonly string _cache = Path.Combine(Path.GetTempPath(), "maple-inspector-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_cache)) Directory.Delete(_cache, true); }

    [Fact]
    public async Task FailedSidecarDoesNotHideAvailableEnrichmentAndCanRetry()
    {
        var failed = true;
        using var handler = new Responses((path, _) => Task.FromResult(path == "/api/xmp"
            ? new HttpResponseMessage(failed ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK) { Content = new StringContent("<x/>") }
            : Json("{\"description\":\"Available caption\"}")));
        using var client = new CloudClient("https://inspector.invalid", handler, _cache);
        var first = await client.ReadInspectorAsync("/a.dng", CancellationToken.None);
        Assert.True(first.SidecarUnavailable);
        Assert.Null(first.Xmp);
        Assert.False(first.EnrichmentUnavailable);
        Assert.Equal("Available caption", first.Enrichment!.Description);
        failed = false;
        var second = await client.ReadInspectorAsync("/a.dng", CancellationToken.None);
        Assert.False(second.SidecarUnavailable);
        Assert.Equal("<x/>", second.Xmp);
    }

    [Fact]
    public async Task UnavailableEnrichmentDoesNotHideSidecar()
    {
        using var handler = new Responses((path, _) => path == "/api/xmp"
            ? Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("<x/>") })
            : Task.FromException<HttpResponseMessage>(new HttpRequestException("offline")));
        using var client = new CloudClient("https://inspector.invalid", handler, _cache);
        var result = await client.ReadInspectorAsync("/a.dng", CancellationToken.None);
        Assert.False(result.SidecarUnavailable);
        Assert.Equal("<x/>", result.Xmp);
        Assert.True(result.EnrichmentUnavailable);
    }

    [Fact]
    public async Task MissingSidecarIsAnHonestEmptyState()
    {
        using var handler = new Responses((path, _) => Task.FromResult(path == "/api/xmp"
            ? new HttpResponseMessage(HttpStatusCode.NotFound) : Json("{}")));
        using var client = new CloudClient("https://inspector.invalid", handler, _cache);
        var result = await client.ReadInspectorAsync("/a.dng", CancellationToken.None);
        Assert.False(result.SidecarUnavailable);
        Assert.Null(result.Xmp);
        Assert.False(result.EnrichmentUnavailable);
        Assert.Empty(result.Enrichment!.Rows());
    }

    [Fact]
    public async Task SelectionCancellationDoesNotBecomeAnUnavailableResult()
    {
        using var cancellation = new CancellationTokenSource();
        var started = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new Responses(async (_, token) =>
        {
            started.TrySetResult(true);
            await Task.Delay(Timeout.Infinite, token);
            return Json("{}");
        });
        using var client = new CloudClient("https://inspector.invalid", handler, _cache);
        var loading = client.ReadInspectorAsync("/a.dng", cancellation.Token);
        await started.Task;
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => loading);
    }

    private static HttpResponseMessage Json(string value) => new(HttpStatusCode.OK) { Content = new StringContent(value) };
    private sealed class Responses(Func<string, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
            => respond(request.RequestUri!.AbsolutePath, token);
    }
}

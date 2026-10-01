using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudPreviewCacheTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-preview-cache-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_root)) Directory.Delete(_root, true); }
    private CloudClient Client(HttpMessageHandler handler) => new("https://maple.example.test", handler, _root);

    [Theory]
    [InlineData("preview")]
    [InlineData("thumb")]
    public async Task ChangedServerPixelsHaveANewUriAndValidatorSurvivesRestart(string kind)
    {
        var firstHandler = new Handler((_, _) => Image(1, "v1"));
        string first;
        using (var client = Client(firstHandler)) first = (await client.FetchImageAsync(kind, "lib:a.dng", default))!;
        var nextHandler = new Handler((request, call) =>
        {
            Assert.Equal(call == 1 ? "\"v1\"" : "\"v2\"", request.Headers.IfNoneMatch.ToString());
            return call == 1 ? Image(2, "v2") : new(HttpStatusCode.NotModified);
        });
        using var reopened = Client(nextHandler);
        var second = await reopened.FetchImageAsync(kind, "lib:a.dng", default);
        Assert.NotEqual(first, second);
        Assert.Equal(new byte[] { 1 }, await File.ReadAllBytesAsync(first));
        Assert.Equal(new byte[] { 2 }, await File.ReadAllBytesAsync(second!));
        var stamp = File.GetLastWriteTimeUtc(second!);
        Assert.Equal(second, await reopened.FetchImageAsync(kind, "lib:a.dng", default));
        Assert.Equal(stamp, File.GetLastWriteTimeUtc(second!));
    }

    [Theory]
    [InlineData("preview")]
    [InlineData("thumb")]
    public async Task MissingPixelsDoNotSendAValidator(string kind)
    {
        var handler = new Handler((request, _) =>
        {
            Assert.Empty(request.Headers.IfNoneMatch);
            return Image(1, "v1");
        });
        using var client = Client(handler);
        var path = await client.FetchImageAsync(kind, "lib:a.dng", default);
        File.Delete(path!);
        Assert.Equal(path, await client.FetchImageAsync(kind, "lib:a.dng", default));
        Assert.True(File.Exists(path));
    }

    [Theory]
    [InlineData("preview")]
    [InlineData("thumb")]
    public async Task NoValidatorStillFetchesChangedPixelsAndCancellationDoesNotServeCache(string kind)
    {
        var handler = new Handler((_, call) => Image((byte)call, null));
        using var client = Client(handler);
        var first = await client.FetchImageAsync(kind, "lib:a.dng", default);
        Assert.NotEqual(first, await client.FetchImageAsync(kind, "lib:a.dng", default));
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.FetchImageAsync(kind, "lib:a.dng", cancelled.Token));
        Assert.Equal(2, handler.Calls);
    }

    [Theory]
    [InlineData("preview")]
    [InlineData("thumb")]
    public async Task ServerFailureDoesNotPresentOldPixelsAsCurrent(string kind)
    {
        var handler = new Handler((_, call) => call == 1 ? Image(1, "v1") : new(HttpStatusCode.NotFound));
        using var client = Client(handler);
        var path = await client.FetchImageAsync(kind, "lib:a.dng", default);
        Assert.Null(await client.FetchImageAsync(kind, "lib:a.dng", default));
        Assert.True(File.Exists(path));
    }

    [Fact]
    public async Task ThumbnailAndPreviewKeepIndependentValidatorsAndPixels()
    {
        var handler = new Handler((request, call) =>
        {
            var thumbnail = request.RequestUri!.AbsolutePath.StartsWith("/api/thumb/");
            var tag = thumbnail ? "thumb-v1" : "preview-v1";
            if (call <= 2)
            {
                Assert.Empty(request.Headers.IfNoneMatch);
                return Image(thumbnail ? (byte)1 : (byte)2, tag);
            }
            Assert.Equal('"' + tag + '"', request.Headers.IfNoneMatch.ToString());
            return new(HttpStatusCode.NotModified);
        });
        using var client = Client(handler);
        var thumbnail = await client.FetchImageAsync("thumb", "lib:a.dng", default);
        var preview = await client.FetchImageAsync("preview", "lib:a.dng", default);
        Assert.NotEqual(thumbnail, preview);
        Assert.Equal(new byte[] { 1 }, await File.ReadAllBytesAsync(thumbnail!));
        Assert.Equal(new byte[] { 2 }, await File.ReadAllBytesAsync(preview!));
        Assert.Equal(thumbnail, await client.FetchImageAsync("thumb", "lib:a.dng", default));
        Assert.Equal(preview, await client.FetchImageAsync("preview", "lib:a.dng", default));
    }

    private static HttpResponseMessage Image(byte value, string? tag)
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new[] { value }) };
        if (tag != null) response.Headers.ETag = new EntityTagHeaderValue('"' + tag + '"');
        return response;
    }

    private sealed class Handler(Func<HttpRequestMessage, int, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(respond(request, ++Calls));
    }
}

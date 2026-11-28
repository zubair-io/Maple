using System.Net;
using System.Text;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudClientRefreshTests : IDisposable
{
    private readonly string _cache = Path.Combine(
        Path.GetTempPath(), "maple-refresh-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_cache, recursive: true); } catch { }
    }

    private static async Task Write(HttpListenerContext context, int status, byte[] body, string? contentType = null)
    {
        context.Response.StatusCode = status;
        if (contentType != null) context.Response.ContentType = contentType;
        context.Response.ContentLength64 = body.Length;
        await context.Response.OutputStream.WriteAsync(body);
    }

    [Fact]
    public async Task EightConcurrentUnauthorizedRequestsShareOneRefresh()
    {
        var refreshes = 0;
        using var server = new ConcurrentLoopbackServer(async context =>
        {
            if (context.Request.Url!.AbsolutePath == "/api/auth/refresh")
            {
                Interlocked.Increment(ref refreshes);
                await Task.Delay(300);
                await Write(context, 200, Encoding.UTF8.GetBytes("{\"access_token\":\"fresh\"}"), "application/json");
                return;
            }
            await (context.Request.Headers["Authorization"] == "Bearer fresh"
                ? Write(context, 200, new byte[] { 3 })
                : Write(context, 401, Array.Empty<byte>()));
        });
        using var client = new CloudClient(server.Url, CloudClient.CreateHandler(), _cache);

        var paths = await Task.WhenAll(Enumerable.Range(0, 8)
            .Select(index => client.FetchImageAsync("thumb", $"lib:tile{index}.dng", default)));

        Assert.All(paths, Assert.NotNull);
        Assert.Equal(1, refreshes);
        Assert.Equal(16, server.Requests.Count(request => request.Target.StartsWith("/api/thumb/")));
    }

    [Fact]
    public async Task ATokenThatExpiresLaterRefreshesAgainOnce()
    {
        var refreshes = 0;
        var current = "t0";
        using var server = new ConcurrentLoopbackServer(async context =>
        {
            if (context.Request.Url!.AbsolutePath == "/api/auth/refresh")
            {
                var token = "t" + Interlocked.Increment(ref refreshes);
                current = token;
                await Write(context, 200, Encoding.UTF8.GetBytes($"{{\"access_token\":\"{token}\"}}"), "application/json");
                return;
            }
            await (context.Request.Headers["Authorization"] == "Bearer " + current
                ? Write(context, 200, new byte[] { 3 })
                : Write(context, 401, Array.Empty<byte>()));
        });
        using var client = new CloudClient(server.Url, CloudClient.CreateHandler(), _cache);

        Assert.NotNull(await client.FetchImageAsync("thumb", "lib:a.dng", default));
        current = "expired-on-server";
        var later = await Task.WhenAll(Enumerable.Range(0, 4)
            .Select(index => client.FetchImageAsync("thumb", $"lib:b{index}.dng", default)));

        Assert.All(later, Assert.NotNull);
        Assert.Equal(2, refreshes);
    }

    [Fact]
    public async Task AFailedRefreshIsNotRepeatedByTheRequestsQueuedBehindIt()
    {
        var refreshes = 0;
        using var server = new ConcurrentLoopbackServer(async context =>
        {
            if (context.Request.Url!.AbsolutePath == "/api/auth/refresh")
            {
                Interlocked.Increment(ref refreshes);
                await Task.Delay(300);
                await Write(context, 429, Array.Empty<byte>());
                return;
            }
            await Write(context, 401, Array.Empty<byte>());
        });
        using var client = new CloudClient(server.Url, CloudClient.CreateHandler(), _cache);

        var paths = await Task.WhenAll(Enumerable.Range(0, 8)
            .Select(index => client.FetchImageAsync("thumb", $"lib:tile{index}.dng", default)));

        Assert.All(paths, Assert.Null);
        Assert.Equal(1, refreshes);
    }

    [Fact]
    public async Task ALaterUnauthorizedRequestRefreshesAgainOnceTheFailureIsOld()
    {
        var refreshes = 0;
        using var server = new ConcurrentLoopbackServer(async context =>
        {
            if (context.Request.Url!.AbsolutePath == "/api/auth/refresh")
            {
                Interlocked.Increment(ref refreshes);
                await Write(context, 503, Array.Empty<byte>());
                return;
            }
            await Write(context, 401, Array.Empty<byte>());
        });
        using var client = new CloudClient(server.Url, CloudClient.CreateHandler(), _cache);

        Assert.Null(await client.FetchImageAsync("thumb", "lib:a.dng", default));
        Assert.Null(await client.FetchImageAsync("thumb", "lib:b.dng", default));
        Assert.Equal(1, refreshes);
        await Task.Delay(5200);
        Assert.Null(await client.FetchImageAsync("thumb", "lib:c.dng", default));

        Assert.Equal(2, refreshes);
    }

    [Fact]
    public async Task AnOriginalDownloadAndThumbnailsShareOneRefresh()
    {
        var refreshes = 0;
        using var server = new ConcurrentLoopbackServer(async context =>
        {
            if (context.Request.Url!.AbsolutePath == "/api/auth/refresh")
            {
                Interlocked.Increment(ref refreshes);
                await Task.Delay(300);
                await Write(context, 200, Encoding.UTF8.GetBytes("{\"access_token\":\"fresh\"}"), "application/json");
                return;
            }
            await (context.Request.Headers["Authorization"] == "Bearer fresh"
                ? Write(context, 200, new byte[] { 3, 3, 3 })
                : Write(context, 401, Array.Empty<byte>()));
        });
        using var client = new CloudClient(server.Url, CloudClient.CreateHandler(), _cache);

        var results = await Task.WhenAll(
            client.FetchImageAsync("thumb", "lib:a.dng", default),
            client.FetchImageAsync("thumb", "lib:b.dng", default),
            client.DownloadOriginalAsync("lib:c.dng", 3, null, default));

        Assert.All(results, Assert.NotNull);
        Assert.Equal(1, refreshes);
    }

    [Fact]
    public async Task RestoringASessionAlwaysRefreshesEvenAfterAnEarlierFailure()
    {
        var refreshes = 0;
        using var server = new ConcurrentLoopbackServer(async context =>
        {
            var count = Interlocked.Increment(ref refreshes);
            await (count == 1
                ? Write(context, 503, Array.Empty<byte>())
                : Write(context, 200, Encoding.UTF8.GetBytes("{\"access_token\":\"fresh\"}"), "application/json"));
        });
        using var client = new CloudClient(server.Url, CloudClient.CreateHandler(), _cache);

        Assert.Equal(RefreshOutcome.Transient, await client.RestoreSessionAsync("r1", default));
        Assert.Equal(RefreshOutcome.Ok, await client.RestoreSessionAsync("r1", default));

        Assert.Equal(2, refreshes);
        Assert.True(client.IsAuthenticated);
    }
}

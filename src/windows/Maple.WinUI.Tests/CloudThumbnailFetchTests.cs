using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudThumbnailFetchTests
{
    [Fact]
    public async Task FortyThumbnailRequestsAgainstAServerPeakAtEightInFlight()
    {
        using var server = new ConcurrentLoopbackServer(async context =>
        {
            await Task.Delay(150);
            context.Response.StatusCode = 200;
            context.Response.ContentLength64 = 1;
            await context.Response.OutputStream.WriteAsync(new byte[] { 7 });
        });
        var cache = Path.Combine(Path.GetTempPath(), "maple-fetch-gate-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var client = new CloudClient(server.Url, CloudClient.CreateHandler(), cache);
            var paths = new System.Collections.Concurrent.ConcurrentBag<string?>();

            await CloudThumbnailFetch.RunAsync(
                Enumerable.Range(0, 40).Select(index => $"lib:tile{index}.dng"),
                async address => paths.Add(await client.FetchImageAsync("thumb", address, default)),
                default);

            Assert.Equal(40, server.Requests.Count);
            Assert.Equal(40, paths.Count(path => path != null));
            Assert.Equal(8, server.PeakInFlight);
        }
        finally { try { Directory.Delete(cache, recursive: true); } catch { } }
    }

    [Fact]
    public async Task NeverMoreThanTheWidthInFlightAndEveryTileIsFetched()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var inFlight = 0;
        var peak = 0;
        var fetched = 0;
        var run = CloudThumbnailFetch.RunAsync(Enumerable.Range(0, 40), async _ =>
        {
            var now = Interlocked.Increment(ref inFlight);
            InterlockedMax(ref peak, now);
            await release.Task;
            Interlocked.Decrement(ref inFlight);
            Interlocked.Increment(ref fetched);
        }, default);

        await WaitUntil(() => Volatile.Read(ref inFlight) == CloudThumbnailFetch.Width);
        await Task.Delay(100);
        Assert.Equal(CloudThumbnailFetch.Width, Volatile.Read(ref inFlight));
        release.SetResult();
        await run;

        Assert.Equal(CloudThumbnailFetch.Width, peak);
        Assert.Equal(40, fetched);
    }

    [Fact]
    public async Task CancellingTheFolderEndsTheRunWithoutFaulting()
    {
        using var cancel = new CancellationTokenSource();
        var started = 0;
        var run = CloudThumbnailFetch.RunAsync(Enumerable.Range(0, 30), async _ =>
        {
            Interlocked.Increment(ref started);
            await Task.Delay(Timeout.Infinite, cancel.Token);
        }, cancel.Token);

        await WaitUntil(() => Volatile.Read(ref started) == CloudThumbnailFetch.Width);
        cancel.Cancel();
        await run;

        Assert.Equal(CloudThumbnailFetch.Width, started);
    }

    private static void InterlockedMax(ref int target, int value)
    {
        int seen;
        while (value > (seen = Volatile.Read(ref target)) && Interlocked.CompareExchange(ref target, value, seen) != seen) { }
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "timed out waiting for the fetch gate to fill");
            await Task.Delay(10);
        }
    }
}

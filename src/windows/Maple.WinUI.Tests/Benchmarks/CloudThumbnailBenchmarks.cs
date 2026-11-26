using Maple.WinUI.Services;
using Maple.WinUI.Services.Cloud;
using System.Net;
using System.Runtime.CompilerServices;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

[Collection(Bench.CollectionName)]
[Trait("Category", "Benchmark")]
public sealed class CloudThumbnailBenchmarks(ITestOutputHelper output)
{
    private const int Rounds = 5;
    private const int Tiles = 200;
    private const int FixtureTiles = 20;
    private const int ServerDelayMilliseconds = 50;
    private static readonly int[] Widths = { 4, 8, 16 };

    [BenchmarkFact(native: true)]
    public async Task Grid_tile_png_fixture_converted_by_the_display_image_cache()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var root = Path.Combine(Bench.FixtureDirectory, "tiles");
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        Directory.CreateDirectory(root);
        var pngDirectory = Path.Combine(root, "png-512");
        var avifs = Enumerable.Range(0, FixtureTiles).Select(seed => DisplayImageCacheConcurrencyTests.WriteAvifTile(root, seed)).ToArray();
        var convert = new List<double>();
        foreach (var avif in avifs)
            convert.Add(await Bench.MeasureAsync(async () => Assert.NotNull(await DisplayImageCache.PrepareAsync(avif, 512, default, pngDirectory))));
        var pngs = Directory.GetFiles(pngDirectory, "*.png");
        Assert.Equal(FixtureTiles, pngs.Length);
        Bench.Line(output, $"tiles: {FixtureTiles} synthetic photographic-noise 640x427 AVIF at {avifs.Average(path => new FileInfo(path).Length) / 1024:0} KiB average became 512 px lossless PNG at {pngs.Average(path => new FileInfo(path).Length) / 1024:0} KiB average (DisplayImageCache.PrepareAsync, one at a time)");
        Bench.Stats(output, "tiles: AVIF to 512 px PNG per tile", convert);
    }

    [BenchmarkFact]
    public async Task Cached_tile_revalidation_and_fetch_width_against_a_loopback_server()
    {
        var bodies = ThumbnailBodies();
        var delay = 0;
        using var server = new LoopbackServer(async context =>
        {
            var path = context.Request.Url!.AbsolutePath;
            if (path == "/api/auth/dev-login") { await LoopbackServer.WriteLoginAsync(context); return; }
            await Task.Delay(Volatile.Read(ref delay));
            var etag = $"\"{path.GetHashCode():x}\"";
            if (context.Request.Headers["If-None-Match"] == etag) { context.Response.StatusCode = 304; return; }
            context.Response.AddHeader("ETag", etag);
            await LoopbackServer.WriteBytesAsync(context, bodies[Math.Abs(path.GetHashCode()) % bodies.Length]);
        });
        var addresses = Enumerable.Range(0, Tiles).Select(index => $"bench:IMG_{index:D4}.DNG").ToArray();
        var cacheRoot = Path.Combine(Path.GetTempPath(), "maple-bench-thumbs-" + Guid.NewGuid().ToString("N"));
        try
        {
            Bench.Line(output, $"D9 client share against a loopback server; fixed server delay {ServerDelayMilliseconds} ms per thumbnail request in the width runs; {Tiles} thumbnails; body {bodies[0].Length / 1024} KiB, {(Bench.NativeAvailable ? "real AVIF" : "opaque bytes (no native library, no PNG step)")}");
            await RevalidationAsync(server.Url, addresses, cacheRoot);
            Volatile.Write(ref delay, ServerDelayMilliseconds);
            await WidthsAsync(server.Url, addresses, cacheRoot);
        }
        finally
        {
            if (Directory.Exists(cacheRoot)) Directory.Delete(cacheRoot, recursive: true);
        }
    }

    private async Task RevalidationAsync(string url, string[] addresses, string cacheRoot)
    {
        var cold = new List<double>();
        var revalidated = new List<double>();
        var noRequest = new List<double>();
        for (var round = 0; round < Rounds; round++)
        {
            using var client = await SignedInAsync(url, Path.Combine(cacheRoot, $"revalidate-{round}"));
            var paths = new List<string>();
            cold.Add(await Bench.MeasureAsync(async () =>
            {
                foreach (var address in addresses) paths.Add((await client.FetchImageAsync("thumb", address, default))!);
            }) / addresses.Length);
            revalidated.Add(await Bench.MeasureAsync(async () =>
            {
                foreach (var address in addresses) Assert.NotNull(await client.FetchImageAsync("thumb", address, default));
            }) / addresses.Length);
            noRequest.Add(Bench.Measure(() => Assert.All(paths, path => Assert.True(File.Exists(path)))) / addresses.Length);
        }
        Bench.Stats(output, "D9 per tile, first fetch (request, body, hash, two cache writes), server delay 0", cold);
        Bench.Stats(output, "D9 per tile, cached copy revalidated (If-None-Match answered 304), server delay 0", revalidated);
        Bench.Stats(output, "D9 per tile, cached copy used with no request (File.Exists on the cached path)", noRequest);
    }

    private async Task WidthsAsync(string url, string[] addresses, string cacheRoot)
    {
        var fetchOnly = Widths.ToDictionary(width => width, _ => new List<double>());
        var fetchAndConvert = Widths.ToDictionary(width => width, _ => new List<double>());
        for (var round = 0; round < Rounds; round++)
        {
            foreach (var width in Widths)
            {
                fetchOnly[width].Add(await FetchAllAsync(url, addresses, Path.Combine(cacheRoot, $"fetch-{width}-{round}"), width, convert: false));
                if (Bench.NativeAvailable)
                    fetchAndConvert[width].Add(await FetchAllAsync(url, addresses, Path.Combine(cacheRoot, $"convert-{width}-{round}"), width, convert: true));
            }
        }
        foreach (var width in Widths)
        {
            Bench.Stats(output, $"D9 {Tiles} thumbnails, width {width}, fetch only, the client's fetch method driven at this width by the benchmark's own gate", fetchOnly[width]);
            if (Bench.NativeAvailable)
                Bench.Stats(output, $"D9 {Tiles} thumbnails, width {width}, fetch then DisplayImageCache.PrepareAsync, the client's fetch method driven at this width by the benchmark's own gate", fetchAndConvert[width]);
        }
    }

    private static async Task<double> FetchAllAsync(string url, string[] addresses, string cache, int width, bool convert)
    {
        using var client = await SignedInAsync(url, cache);
        using var gate = new SemaphoreSlim(width);
        var tiles = Path.Combine(cache, "png");
        return await Bench.MeasureAsync(() => Task.WhenAll(addresses.Select(async address =>
        {
            await gate.WaitAsync();
            try
            {
                var path = await client.FetchImageAsync("thumb", address, default);
                Assert.NotNull(convert ? await DisplayImageCache.PrepareAsync(path, 512, default, tiles) : path);
            }
            finally { gate.Release(); }
        })));
    }

    private static async Task<CloudClient> SignedInAsync(string url, string cache)
    {
        var client = new CloudClient(url, CloudClient.CreateHandler(), cache);
        var login = await client.DevLoginAsync(default);
        Assert.True(login.Ok, login.Message);
        return client;
    }

    private static byte[][] ThumbnailBodies()
    {
        if (!Bench.NativeAvailable)
            return new[] { Enumerable.Range(0, 60 * 1024).Select(index => (byte)(index * 31)).ToArray() };
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var root = Path.Combine(Bench.FixtureDirectory, "thumb-bodies");
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        Directory.CreateDirectory(root);
        return Enumerable.Range(0, FixtureTiles).Select(seed => File.ReadAllBytes(DisplayImageCacheConcurrencyTests.WriteAvifTile(root, seed))).ToArray();
    }
}

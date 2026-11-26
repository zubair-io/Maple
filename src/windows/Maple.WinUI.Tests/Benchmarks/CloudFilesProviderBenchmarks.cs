using System.Diagnostics;
using System.Net;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.CloudFiles;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

[Collection(Bench.CollectionName)]
[Trait("Category", "Benchmark")]
public sealed class CloudFilesProviderBenchmarks(ITestOutputHelper output)
{
    private const int Rounds = 5;
    private const int Items = 2000;
    private const int PageSize = 500;
    private const int HydratedBytes = 10 * 1024 * 1024;
    private const string LibraryLabel = "Bench Library";
    private const string HydratedName = "IMG_0000.DNG";

    [BenchmarkFact]
    public async Task Provider_listing_and_hydration_against_a_loopback_server()
    {
        var body = new byte[HydratedBytes];
        new Random(7).NextBytes(body);
        using var server = new LoopbackServer(context => RouteAsync(context, body));
        var cache = Path.Combine(Path.GetTempPath(), "maple-bench-cf-cache-" + Guid.NewGuid().ToString("N"));
        try
        {
            Bench.Line(output, $"W17 loopback server: one library of {Items} items listed {PageSize} per page, one {HydratedBytes / (1024 * 1024)} MiB original; OS {Environment.OSVersion}");
            await ProviderCodeAsync(server.Url, cache, body.Length);
            await RegisteredSyncRootAsync(server.Url, cache);
        }
        finally
        {
            if (Directory.Exists(cache)) Directory.Delete(cache, recursive: true);
        }
    }

    private async Task ProviderCodeAsync(string url, string cache, int expectedBytes)
    {
        var listings = new List<double>();
        var hydrations = new List<double>();
        for (var round = 0; round < Rounds; round++)
        {
            using var client = await SignedInAsync(url, Path.Combine(cache, $"code-{round}"));
            var transferred = 0;
            listings.Add(await Bench.MeasureAsync(async () =>
            {
                var result = await CloudFilesListing.StreamPagesAsync(async cursor =>
                {
                    var page = await client.ListFolderAddressAsync("bench:", cursor, PageSize, default);
                    return page == null ? null : new PlaceholderPage(CloudFilesAddress.MapListing(page), page.NextCursor);
                }, (entries, _) => { transferred += entries.Count; return true; });
                Assert.True(result.Complete);
            }));
            Assert.Equal(Items, transferred);
            long delivered = 0;
            hydrations.Add(await Bench.MeasureAsync(async () =>
            {
                using var response = await client.OpenOriginalAsync("bench:" + HydratedName, "0123456789abcdef01234567", HydratedName, default);
                await using var stream = await response!.Content.ReadAsStreamAsync();
                delivered = await CloudFilesHydration.StreamAlignedAsync(stream, 4096, (_, _, _) => { }, default);
            }));
            Assert.Equal(expectedBytes, delivered);
        }
        Bench.Line(output, "W17 provider code only (CloudClient listing + CloudFilesAddress.MapListing + CloudFilesListing.StreamPagesAsync with a counting transfer; CfExecute placeholder creation NOT included)");
        Bench.Stats(output, $"W17 listing {Items} items to placeholder entries, rounds", listings);
        Bench.Line(output, "W17 provider code only (CloudClient.OpenOriginalAsync + CloudFilesHydration.StreamAlignedAsync with a discarding delivery; CfExecuteTransferData NOT included)");
        Bench.Stats(output, $"W17 hydration stream of {HydratedBytes / (1024 * 1024)} MiB, rounds", hydrations);
    }

    private async Task RegisteredSyncRootAsync(string url, string cache)
    {
        if (!OperatingSystem.IsWindows())
        {
            Bench.Line(output, "W17 registered sync root: NOT REACHABLE, not a Windows host");
            return;
        }
        var plain = CreatePlainFolder();
        try
        {
            var plainList = Enumerable.Range(0, Rounds).Select(_ => RunCmd($"dir /b \"{plain.Directory}\"").Milliseconds).ToArray();
            var plainCopy = Enumerable.Range(0, Rounds).Select(_ => RunCmd($"copy /b \"{plain.File}\" nul").Milliseconds).ToArray();
            var starts = new List<double>();
            var populates = new List<double>();
            var hydrates = new List<double>();
            var stops = new List<double>();
            for (var round = 0; round < Rounds; round++)
            {
                var root = Path.Combine(Path.GetTempPath(), "Maple-Bench-CF-" + Guid.NewGuid().ToString("N"));
                using var client = await SignedInAsync(url, Path.Combine(cache, $"root-{round}"));
                using var provider = new CloudFilesSyncRoot(() => client, root);
                string? error = null;
                var start = Bench.Measure(() => error = provider.Start());
                if (error != null)
                {
                    Bench.Line(output, $"W17 registered sync root: NOT REACHABLE on this runner, Start() said: {error}");
                    return;
                }
                string? unreachable = null;
                try
                {
                    starts.Add(start);
                    var libraries = RunCmd($"dir /b \"{root}\"");
                    Assert.Contains(LibraryLabel, libraries.Output);
                    var population = RunCmd($"dir /b \"{Path.Combine(root, LibraryLabel)}\"");
                    Assert.Equal(Items, population.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
                    populates.Add(population.Milliseconds);
                    var hydration = RunCmd($"copy /b \"{Path.Combine(root, LibraryLabel, HydratedName)}\" nul");
                    Assert.Contains("1 file(s) copied", hydration.Output);
                    hydrates.Add(hydration.Milliseconds);
                }
                catch (Exception failure) when (failure is Xunit.Sdk.XunitException or TimeoutException or IOException)
                {
                    unreachable = failure.Message.ReplaceLineEndings(" ").Trim();
                }
                finally
                {
                    stops.Add(Bench.Measure(() => provider.Stop(unregister: true)));
                    if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
                }
                if (unreachable != null)
                {
                    Bench.Line(output, $"W17 registered sync root: Start() succeeded in {start:0.0} ms, but the OS listing or copy through it did not complete on this runner, so placeholder creation and hydration through the filter driver are NOT measured: {unreachable}");
                    return;
                }
            }
            Bench.Line(output, "W17 registered sync root through the production CloudFilesSyncRoot; the OS client is a cmd.exe child process, so each time includes about one process start (baselines below are the same commands on a plain NTFS folder)");
            Bench.Stats(output, "W17 sync root Start() (register and connect), rounds", starts);
            Bench.Stats(output, $"W17 first listing of the library: {Items} placeholders created through FETCH_PLACEHOLDERS, rounds", populates);
            Bench.Stats(output, $"W17 hydrate one {HydratedBytes / (1024 * 1024)} MiB placeholder through FETCH_DATA, rounds", hydrates);
            Bench.Stats(output, "W17 Stop(unregister: true) including the placeholder sweep, rounds", stops);
            Bench.Stats(output, $"W17 baseline: dir /b of a plain folder of {Items} files", plainList);
            Bench.Stats(output, $"W17 baseline: copy /b of a plain {HydratedBytes / (1024 * 1024)} MiB file", plainCopy);
        }
        finally { Directory.Delete(plain.Directory, recursive: true); }
    }

    private static (string Directory, string File) CreatePlainFolder()
    {
        var directory = Path.Combine(Path.GetTempPath(), "Maple-Bench-Plain-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        foreach (var index in Enumerable.Range(0, Items)) File.WriteAllBytes(Path.Combine(directory, $"IMG_{index:D4}.DNG"), Array.Empty<byte>());
        var file = Path.Combine(directory, HydratedName);
        File.WriteAllBytes(file, new byte[HydratedBytes]);
        return (directory, file);
    }

    private static (double Milliseconds, string Output) RunCmd(string command)
    {
        var start = new ProcessStartInfo("cmd.exe", $"/d /c {command}")
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        var started = Stopwatch.GetTimestamp();
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEnd();
        if (!process.WaitForExit(60_000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException($"cmd /c {command} did not return within 60 seconds.");
        }
        var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        Assert.True(process.ExitCode == 0, process.StandardError.ReadToEnd());
        return (elapsed, output);
    }

    private static async Task<CloudClient> SignedInAsync(string url, string cache)
    {
        var client = new CloudClient(url, CloudClient.CreateHandler(), cache);
        var login = await client.DevLoginAsync(default);
        Assert.True(login.Ok, login.Message);
        return client;
    }

    private static async Task RouteAsync(HttpListenerContext context, byte[] body)
    {
        var path = context.Request.Url!.AbsolutePath;
        if (path == "/api/auth/dev-login")
            await LoopbackServer.WriteLoginAsync(context);
        else if (path == "/api/folders")
            await LoopbackServer.WriteJsonAsync(context,
                $$"""[{"id":"0123456789abcdef01234567","slug":"bench","label":"{{LibraryLabel}}","path":"/bench","file_count":{{Items}}}]""");
        else if (path == "/api/folder/bench")
            await LoopbackServer.WriteJsonAsync(context, ListingPage(context.Request.QueryString["cursor"], body.Length));
        else if (path == "/api/image/bench/" + HydratedName)
            await LoopbackServer.WriteBytesAsync(context, body);
        else
            context.Response.StatusCode = 404;
    }

    private static string ListingPage(string? cursor, int hydratedBytes)
    {
        var first = cursor == null ? 0 : int.Parse(cursor);
        var next = first + PageSize < Items ? $"\"{first + PageSize}\"" : "null";
        var images = Enumerable.Range(first, PageSize).Select(index =>
        {
            var name = $"IMG_{index:D4}.DNG";
            return $$"""{"name":"{{name}}","address":"bench:{{name}}","path":"/bench/{{name}}","size":{{(index == 0 ? hydratedBytes : 8_000_000)}},"mtime":"2026-01-01T00:00:00Z"}""";
        });
        return $$"""{"images":[{{string.Join(",", images)}}],"next_cursor":{{next}}}""";
    }
}

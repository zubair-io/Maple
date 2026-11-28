using System.Net;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudThumbnailTokenTests : IDisposable
{
    private readonly string _cache = Path.Combine(
        Path.GetTempPath(), "maple-thumb-token-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_cache, recursive: true); } catch { }
    }

    private sealed record Seen(string Target, string? IfNoneMatch);

    private sealed class Origin : IDisposable
    {
        private readonly HttpListener _listener = new();
        private readonly Task _loop;
        private readonly Func<Seen, (int Status, byte[] Body, string? ETag)> _answer;
        private readonly List<Seen> _seen = new();

        public Origin(Func<Seen, (int Status, byte[] Body, string? ETag)> answer)
        {
            _answer = answer;
            var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Url = $"http://127.0.0.1:{port}";
            _listener.Prefixes.Add(Url + "/");
            _listener.Start();
            _loop = Task.Run(Serve);
        }

        public string Url { get; }

        public IReadOnlyList<Seen> Requests { get { lock (_seen) return _seen.ToArray(); } }

        private async Task Serve()
        {
            while (_listener.IsListening)
            {
                HttpListenerContext context;
                try { context = await _listener.GetContextAsync(); }
                catch (Exception ex) when (ex is HttpListenerException or ObjectDisposedException) { return; }
                var seen = new Seen(context.Request.Url!.PathAndQuery, context.Request.Headers["If-None-Match"]);
                lock (_seen) _seen.Add(seen);
                var (status, body, etag) = _answer(seen);
                context.Response.StatusCode = status;
                if (etag != null) context.Response.AddHeader("ETag", etag);
                context.Response.ContentLength64 = status == 304 ? 0 : body.Length;
                if (status != 304) await context.Response.OutputStream.WriteAsync(body);
                context.Response.Close();
            }
        }

        public void Dispose()
        {
            _listener.Close();
            _loop.Wait(TimeSpan.FromSeconds(5));
        }
    }

    private static (int, byte[], string?) Bytes(byte value, string? etag = null) => (200, new[] { value }, etag);

    private const string Address = "lib:2024/a b.dng";
    private const string Route = "/api/thumb/lib/2024/a%20b.dng";

    [Fact]
    public async Task TheTokenRidesInTheQueryStringOnlyAndTheCacheFileStaysPathKeyed()
    {
        using var origin = new Origin(seen => Bytes(seen.Target.EndsWith("?v=t1") ? (byte)1 : (byte)2));
        using var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache);

        var first = await client.FetchImageAsync("thumb", Address, default, "t1");
        var second = await client.FetchImageAsync("thumb", Address, default, "t2");

        Assert.Equal(new[] { Route + "?v=t1", Route + "?v=t2" }, origin.Requests.Select(request => request.Target));
        Assert.All(origin.Requests, request => Assert.Null(request.IfNoneMatch));
        Assert.DoesNotContain("t1", Path.GetFileName(first!));
        Assert.DoesNotContain("t2", Path.GetFileName(second!));
        Assert.Equal(Path.GetFileName(first!)[..32], Path.GetFileName(second!)[..32]);
        Assert.Single(Directory.GetFiles(_cache, "*-thumb.json"));
    }

    [Fact]
    public async Task ACachedCopyWithTheSameTokenMakesNoRequestEvenAfterARestart()
    {
        using var origin = new Origin(_ => Bytes(1, "\"e1\""));
        string first;
        using (var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache))
            first = (await client.FetchImageAsync("thumb", Address, default, "t1"))!;

        using var reopened = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache);
        var again = await reopened.FetchImageAsync("thumb", Address, default, "t1");
        var stamp = File.GetLastWriteTimeUtc(first);

        Assert.Equal(first, again);
        Assert.Single(origin.Requests);
        Assert.Equal(stamp, File.GetLastWriteTimeUtc(again!));
    }

    [Fact]
    public async Task ADifferentTokenFetchesFreshBytesAndReplacesTheCachedCopy()
    {
        using var origin = new Origin(seen => Bytes(seen.Target.EndsWith("?v=t1") ? (byte)1 : (byte)2, "\"e\""));
        using var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache);

        var old = await client.FetchImageAsync("thumb", Address, default, "t1");
        var replaced = await client.FetchImageAsync("thumb", Address, default, "t2");
        Assert.Equal(new byte[] { 2 }, await File.ReadAllBytesAsync(replaced!));
        var current = await client.FetchImageAsync("thumb", Address, default, "t2");
        var staleToken = await client.FetchImageAsync("thumb", Address, default, "t1");

        Assert.Equal(replaced, current);
        Assert.Equal(new byte[] { 1 }, await File.ReadAllBytesAsync(staleToken!));
        Assert.Equal(old, staleToken);
        Assert.Equal(
            new[] { Route + "?v=t1", Route + "?v=t2", Route + "?v=t1" },
            origin.Requests.Select(request => request.Target));
        Assert.Single(Directory.GetFiles(_cache, "*-thumb.json"));
    }

    [Fact]
    public async Task AMissingTokenBehavesAsBeforeAndRevalidatesWithTheStoredETag()
    {
        using var origin = new Origin(seen => seen.IfNoneMatch == "\"e1\"" ? (304, Array.Empty<byte>(), null) : Bytes(1, "\"e1\""));
        using var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache);

        var first = await client.FetchImageAsync("thumb", Address, default);
        var revalidated = await client.FetchImageAsync("thumb", Address, default);

        Assert.Equal(first, revalidated);
        Assert.Equal(new[] { Route, Route }, origin.Requests.Select(request => request.Target));
        Assert.Equal(new string?[] { null, "\"e1\"" }, origin.Requests.Select(request => request.IfNoneMatch));
    }

    [Fact]
    public async Task ARevalidatedCopyKeepsItsTokenButAnUnversionedDownloadDropsIt()
    {
        var bytes = (byte)1;
        using var origin = new Origin(seen =>
            seen.IfNoneMatch == $"\"e{bytes}\"" ? (304, Array.Empty<byte>(), null) : Bytes(bytes, $"\"e{bytes}\""));
        using var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache);

        var first = await client.FetchImageAsync("thumb", Address, default, "t1");
        Assert.Equal(first, await client.FetchImageAsync("thumb", Address, default));
        Assert.Equal(first, await client.FetchImageAsync("thumb", Address, default, "t1"));
        Assert.Equal(2, origin.Requests.Count);

        bytes = 2;
        var changed = await client.FetchImageAsync("thumb", Address, default);
        Assert.NotEqual(first, changed);
        var afterChange = await client.FetchImageAsync("thumb", Address, default, "t1");

        Assert.Equal(new byte[] { 2 }, await File.ReadAllBytesAsync(afterChange!));
        Assert.Equal(new[] { Route + "?v=t1", Route, Route, Route + "?v=t1" }, origin.Requests.Select(request => request.Target));
    }

    [Fact]
    public async Task ReplacingACopyDeletesTheSupersededFileButKeepsSharedBytes()
    {
        using var origin = new Origin(seen => Bytes(seen.Target.EndsWith("?v=t2") ? (byte)2 : (byte)1));
        using var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache);

        var old = await client.FetchImageAsync("thumb", Address, default, "t1");
        var sameBytes = await client.FetchImageAsync("thumb", Address, default, "t1b");
        Assert.Equal(old, sameBytes);
        Assert.True(File.Exists(old));

        var replaced = await client.FetchImageAsync("thumb", Address, default, "t2");

        Assert.NotEqual(old, replaced);
        Assert.False(File.Exists(old));
        Assert.True(File.Exists(replaced));
        Assert.Equal(new[] { replaced }, Directory.GetFiles(_cache, "*-thumb.avif"));
    }

    [Fact]
    public async Task ReplacingACopyAlsoDeletesTheDisplayPngDerivedFromTheSupersededFile()
    {
        var display = Path.Combine(_cache, "local-cache");
        Directory.CreateDirectory(display);
        using var origin = new Origin(seen => Bytes(seen.Target.EndsWith("?v=t2") ? (byte)2 : (byte)1));
        using var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache) { DisplayCacheDirectory = display };
        var old = await client.FetchImageAsync("thumb", Address, default, "t1");
        var derived = Maple.WinUI.Services.DisplayImageCache.DerivedPath(old!, 512, display);
        File.WriteAllBytes(derived, new byte[] { 9 });
        var unrelated = Path.Combine(display, "unrelated.png");
        File.WriteAllBytes(unrelated, new byte[] { 9 });

        var replaced = await client.FetchImageAsync("thumb", Address, default, "t2");

        Assert.False(File.Exists(old));
        Assert.False(File.Exists(derived));
        Assert.True(File.Exists(unrelated));
        Assert.True(File.Exists(replaced));
    }

    [Fact]
    public async Task AnIndexWrittenBeforeTokensExistedStillRevalidatesAndTheTokenFetchesOnce()
    {
        using var origin = new Origin(seen => seen.IfNoneMatch == "\"e1\"" ? (304, Array.Empty<byte>(), null) : Bytes(1, "\"e1\""));
        string first;
        using (var writer = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache))
            first = (await writer.FetchImageAsync("thumb", Address, default))!;
        var index = Assert.Single(Directory.GetFiles(_cache, "*-thumb.json"));
        var stored = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(index))!.AsObject();
        stored.Remove("Version");
        File.WriteAllText(index, stored.ToJsonString());
        Assert.DoesNotContain("Version", File.ReadAllText(index));

        using var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache);
        Assert.Equal(first, await client.FetchImageAsync("thumb", Address, default));
        Assert.Equal(first, await client.FetchImageAsync("thumb", Address, default, "t1"));
        Assert.Equal(first, await client.FetchImageAsync("thumb", Address, default, "t1"));

        Assert.Equal(new[] { Route, Route, Route + "?v=t1" }, origin.Requests.Select(request => request.Target));
        Assert.Equal(new string?[] { null, "\"e1\"", null }, origin.Requests.Select(request => request.IfNoneMatch));
    }

    [Fact]
    public async Task AFailedTokenFetchReturnsNothingAndKeepsTheStaleCopyAndItsToken()
    {
        using var origin = new Origin(seen => seen.Target.EndsWith("?v=t2") ? (503, Array.Empty<byte>(), null) : Bytes(1, "\"e1\""));
        using var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache);
        var stale = await client.FetchImageAsync("thumb", Address, default, "t1");

        Assert.Null(await client.FetchImageAsync("thumb", Address, default, "t2"));

        Assert.True(File.Exists(stale));
        Assert.Equal(new byte[] { 1 }, await File.ReadAllBytesAsync(stale!));
        Assert.Equal(stale, await client.FetchImageAsync("thumb", Address, default, "t1"));
        Assert.Equal(2, origin.Requests.Count);
    }

    [Fact]
    public async Task ATokenWhoseCachedFileIsGoneFetchesAgain()
    {
        using var origin = new Origin(_ => Bytes(1, "\"e1\""));
        using var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache);

        var path = await client.FetchImageAsync("thumb", Address, default, "t1");
        File.Delete(path!);
        var again = await client.FetchImageAsync("thumb", Address, default, "t1");

        Assert.Equal(path, again);
        Assert.True(File.Exists(again));
        Assert.Equal(2, origin.Requests.Count);
    }

    [Fact]
    public async Task TheTokenIsEscapedAndFailuresCacheNothing()
    {
        using var origin = new Origin(_ => (404, Array.Empty<byte>(), null));
        using var client = new CloudClient(origin.Url, CloudClient.CreateHandler(), _cache);

        Assert.Null(await client.FetchImageAsync("thumb", Address, default, "a b&c"));

        Assert.Equal(Route + "?v=a%20b%26c", Assert.Single(origin.Requests).Target);
        Assert.Empty(Directory.GetFiles(_cache));
    }

    [Fact]
    public void ListingsCarryTheTokenIntoThePhotoTile()
    {
        var listing = System.Text.Json.JsonSerializer.Deserialize<CloudFolderListing>(
            "{\"images\":[{\"name\":\"a.dng\",\"address\":\"lib:a.dng\",\"ext\":\"dng\",\"thumbVersion\":\"1700000000-1\"}," +
            "{\"name\":\"b.dng\",\"address\":\"lib:b.dng\",\"ext\":\"dng\"}]}")!;

        var tiles = listing.Images.Select(CloudPhotoMapper.FromDirectory).ToArray();

        Assert.Equal("1700000000-1", tiles[0].ThumbVersion);
        Assert.Null(tiles[1].ThumbVersion);
    }

    [Fact]
    public void SearchResultsCarryTheirSnakeCaseTokenIntoThePhotoTile()
    {
        var photo = System.Text.Json.JsonSerializer.Deserialize<CloudTimelinePhoto>(
            "{\"address\":\"lib:a.dng\",\"abs_path\":\"/lib/a.dng\",\"filename\":\"a.dng\",\"mtime\":1.5,\"thumb_version\":\"abc-1\"}")!;

        Assert.Equal("abc-1", CloudPhotoMapper.FromTimeline(photo).ThumbVersion);
    }
}

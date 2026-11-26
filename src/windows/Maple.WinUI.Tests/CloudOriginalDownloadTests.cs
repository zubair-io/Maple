// Download-to-edit through GET /api/image/:slug/* (#6104), pinned against fake
// transports (no server, no network).

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class CloudOriginalDownloadTests : IDisposable
    {
        private const string Server = "https://maple.example.test";
        private readonly string _cacheDir = Path.Combine(
            Path.GetTempPath(), "maple-clouddownload-tests-" + Guid.NewGuid().ToString("N"));

        public void Dispose()
        {
            try { Directory.Delete(_cacheDir, recursive: true); } catch { /* best effort */ }
        }

        private CloudClient Client(System.Net.Http.HttpMessageHandler handler) => new(Server, handler, _cacheDir);

        private static byte[] Json(string text) => Encoding.UTF8.GetBytes(text);

        [Fact]
        public async Task DownloadOriginalAsync_UsesUnifiedImageRoute_StreamsToCacheWithProgress()
        {
            var body = new byte[3_000_000];
            new Random(2).NextBytes(body);
            var handler = new FakeHandler().Then(HttpStatusCode.OK, body, "application/octet-stream");
            using var client = Client(handler);
            var progress = new List<(long received, long total)>();

            var path = await client.DownloadOriginalAsync(
                "photos:2024/Trip A/IMG_0001.CR2", body.Length, (r, t) => progress.Add((r, t)), CancellationToken.None);

            var request = Assert.Single(handler.Requests);
            Assert.Equal(HttpMethod.Get, request.Method);
            Assert.Equal($"{Server}/api/image/photos/2024/Trip%20A/IMG_0001.CR2", request.RequestUri!.AbsoluteUri);
            Assert.NotNull(path);
            Assert.EndsWith("-IMG_0001.CR2", path);
            Assert.Equal(body, await File.ReadAllBytesAsync(path!));
            Assert.NotEmpty(progress);
            Assert.Equal((body.Length, (long)body.Length), progress[^1]);
            Assert.All(progress, p => Assert.Equal(body.Length, p.total));
        }

        [Fact]
        public async Task DownloadOriginalAsync_CachedCopyOfExpectedSize_NoRequest()
        {
            var body = new byte[4096];
            var handler = new FakeHandler().Then(HttpStatusCode.OK, body, "application/octet-stream");
            using var client = Client(handler);

            var first = await client.DownloadOriginalAsync("lib:x.dng", body.Length, null, CancellationToken.None);
            var second = await client.DownloadOriginalAsync("lib:x.dng", body.Length, null, CancellationToken.None);

            Assert.Equal(first, second);
            Assert.Single(handler.Requests);
        }

        [Fact]
        public async Task DownloadOriginalAsync_CachedCopyOfAnotherSizeIsFetchedAgain()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, new byte[10], "application/octet-stream")
                .Then(HttpStatusCode.OK, new byte[20], "application/octet-stream");
            using var client = Client(handler);

            await client.DownloadOriginalAsync("lib:x.dng", 10, null, CancellationToken.None);
            var path = await client.DownloadOriginalAsync("lib:x.dng", 20, null, CancellationToken.None);

            Assert.Equal(2, handler.Requests.Count);
            Assert.Equal(20, new FileInfo(path!).Length);
        }

        [Fact]
        public async Task DownloadOriginalAsync_DistinctAddressesNeverShareACacheEntry()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, new byte[] { 1 }, "application/octet-stream")
                .Then(HttpStatusCode.OK, new byte[] { 2 }, "application/octet-stream");
            using var client = Client(handler);

            var a = await client.DownloadOriginalAsync("one:x.dng", 0, null, CancellationToken.None);
            var b = await client.DownloadOriginalAsync("two:x.dng", 0, null, CancellationToken.None);

            Assert.NotEqual(a, b);
            Assert.Equal(new byte[] { 1 }, await File.ReadAllBytesAsync(a!));
            Assert.Equal(new byte[] { 2 }, await File.ReadAllBytesAsync(b!));
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        public async Task DownloadOriginalAsync_PhotoWithoutAnAddressIsNull_NoRequest(string? address)
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, new byte[1], "application/octet-stream");
            using var client = Client(handler);

            Assert.Null(await client.DownloadOriginalAsync(address, 1, null, CancellationToken.None));
            Assert.Empty(handler.Requests);
        }

        [Theory]
        [InlineData(HttpStatusCode.Forbidden)]
        [InlineData(HttpStatusCode.NotFound)]
        [InlineData(HttpStatusCode.UnsupportedMediaType)]
        [InlineData(HttpStatusCode.InternalServerError)]
        public async Task DownloadOriginalAsync_NonSuccessIsNull_NothingCached(HttpStatusCode status)
        {
            var handler = new FakeHandler().Then(status, Json("{\"error\":\"no\"}"), "application/json");
            using var client = Client(handler);

            Assert.Null(await client.DownloadOriginalAsync("lib:gone.CR2", 1, null, CancellationToken.None));
            Assert.Empty(Directory.GetFiles(Path.Combine(_cacheDir, "originals")));
        }

        [Fact]
        public async Task DownloadOriginalAsync_UnauthorizedRefreshesTheTokenOnceAndRetries()
        {
            var handler = new FakeHandler()
                .Then(HttpStatusCode.Unauthorized)
                .Then(HttpStatusCode.OK, Json("{\"access_token\":\"fresh\"}"), "application/json")
                .Then(HttpStatusCode.OK, new byte[] { 5, 6 }, "application/octet-stream");
            using var client = Client(handler);

            var path = await client.DownloadOriginalAsync("lib:a.dng", 2, null, CancellationToken.None);

            Assert.Equal(new byte[] { 5, 6 }, await File.ReadAllBytesAsync(path!));
            Assert.Equal(
                new[] { "/api/image/lib/a.dng", "/api/auth/refresh", "/api/image/lib/a.dng" },
                handler.Requests.Select(r => r.RequestUri!.AbsolutePath));
        }

        [Fact]
        public async Task DownloadOriginalAsync_CancellationPropagatesAndLeavesNothingCached()
        {
            var handler = new HangingHandler();
            using var client = Client(handler);
            using var cts = new CancellationTokenSource();

            var download = client.DownloadOriginalAsync("lib:big.dng", 100, null, cts.Token);
            await handler.Started.Task;
            cts.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => download);
            Assert.Empty(Directory.GetFiles(Path.Combine(_cacheDir, "originals")));
        }

        [Fact]
        public async Task DownloadOriginalAsync_CancelledWhileStreamingRemovesThePartialFile()
        {
            var body = new byte[3_000_000];
            using var client = Client(new FakeHandler().Then(HttpStatusCode.OK, body, "application/octet-stream"));
            using var cts = new CancellationTokenSource();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.DownloadOriginalAsync(
                "lib:big.dng", body.Length, (_, _) => cts.Cancel(), cts.Token));

            Assert.Empty(Directory.GetFiles(Path.Combine(_cacheDir, "originals")));
        }
    }
}

// CloudClientRoutesTests — the routes the Windows Maple Cloud client speaks
// after the #1325 cutover, pinned against a fake HttpMessageHandler through
// CloudClient's internal transport constructor (no server, no network).
//
// What moved: thumbnails and previews are fetched by `slug:relPath` address
// (GET /api/thumb/:slug/*, /api/preview/:slug/*), the unified routes the web
// grid reads. What deliberately stayed path-addressed, and why, is in the
// per-method comments in Services/Cloud/CloudClient.*.cs: the directory
// listing (GET /api/fs/dir — the unified listing carries no size/mtime/EXIF
// and no absolute path) and the original bytes (GET /api/fs/raw — the only
// route with the #926 mirror read-failover). These tests pin both halves so
// a future route swap is a deliberate test change, not a silent one.

using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class CloudClientRoutesTests : IDisposable
    {
        private const string Server = "https://maple.example.test";
        private readonly string _cacheDir = Path.Combine(
            Path.GetTempPath(), "maple-cloudclient-tests-" + Guid.NewGuid().ToString("N"));

        public void Dispose()
        {
            try { Directory.Delete(_cacheDir, recursive: true); } catch { /* best effort */ }
        }

        /// <summary>Records every request and answers from a queue of
        /// canned responses (the last one repeats).</summary>
        private sealed class FakeHandler : HttpMessageHandler
        {
            public List<HttpRequestMessage> Requests { get; } = new();
            private readonly Queue<Func<HttpResponseMessage>> _responses = new();
            private Func<HttpResponseMessage>? _last;

            public FakeHandler Then(HttpStatusCode status, byte[]? body = null, string? contentType = null)
            {
                _responses.Enqueue(() =>
                {
                    var response = new HttpResponseMessage(status);
                    if (body != null)
                    {
                        response.Content = new ByteArrayContent(body);
                        if (contentType != null)
                            response.Content.Headers.ContentType =
                                new System.Net.Http.Headers.MediaTypeHeaderValue(contentType);
                    }
                    return response;
                });
                return this;
            }

            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Requests.Add(request);
                if (_responses.Count > 0)
                    _last = _responses.Dequeue();
                return Task.FromResult((_last ?? throw new InvalidOperationException("no canned response"))());
            }
        }

        private CloudClient Client(HttpMessageHandler handler) => new(Server, handler, _cacheDir);

        private static byte[] Json(string text) => Encoding.UTF8.GetBytes(text);

        // --- Thumbs / previews: unified `slug:relPath` routes ---

        [Fact]
        public async Task FetchImageAsync_Thumb_HitsUnifiedThumbRoute_SegmentEncoded()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, new byte[] { 1, 2, 3 }, "image/avif");
            using var client = Client(handler);

            var path = await client.FetchImageAsync("thumb", "family-2024:2024/Trip A/IMG_0001.CR2", CancellationToken.None);

            var request = Assert.Single(handler.Requests);
            Assert.Equal(HttpMethod.Get, request.Method);
            Assert.Equal($"{Server}/api/thumb/family-2024/2024/Trip%20A/IMG_0001.CR2", request.RequestUri!.AbsoluteUri);
            Assert.NotNull(path);
            Assert.Equal(new byte[] { 1, 2, 3 }, await File.ReadAllBytesAsync(path!));
            Assert.EndsWith("-thumb.avif", path);
        }

        [Fact]
        public async Task FetchImageAsync_Preview_HitsUnifiedPreviewRoute()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, new byte[] { 9 }, "image/avif");
            using var client = Client(handler);

            var path = await client.FetchImageAsync("preview", "lib:photo.dng", CancellationToken.None);

            var request = Assert.Single(handler.Requests);
            Assert.Equal($"{Server}/api/preview/lib/photo.dng", request.RequestUri!.AbsoluteUri);
            Assert.NotNull(path);
            Assert.EndsWith("-preview.avif", path);
        }

        [Fact]
        public async Task FetchImageAsync_EncodesEachSegmentIndividually_NeverTheSlashes()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, new byte[] { 0 }, "image/avif");
            using var client = Client(handler);

            await client.FetchImageAsync("thumb", "my lib:a b/c#d/e%f.jpg", CancellationToken.None);

            Assert.Equal(
                $"{Server}/api/thumb/my%20lib/a%20b/c%23d/e%25f.jpg",
                Assert.Single(handler.Requests).RequestUri!.AbsoluteUri);
        }

        [Fact]
        public async Task FetchImageAsync_SecondCallIsServedFromDiskCache_NoRequest()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, new byte[] { 4, 5 }, "image/avif");
            using var client = Client(handler);

            var first = await client.FetchImageAsync("thumb", "lib:x.dng", CancellationToken.None);
            var second = await client.FetchImageAsync("thumb", "lib:x.dng", CancellationToken.None);

            Assert.Equal(first, second);
            Assert.Single(handler.Requests);
        }

        [Fact]
        public async Task FetchImageAsync_NonSuccessIsNull_NothingCached()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.NotFound, Json("{\"error\":\"File not found\"}"), "application/json");
            using var client = Client(handler);

            var path = await client.FetchImageAsync("thumb", "lib:missing.dng", CancellationToken.None);

            Assert.Null(path);
            Assert.Empty(Directory.GetFiles(_cacheDir));
        }

        [Fact]
        public async Task FetchImageAsync_202StillIndexing_RetriesOnceThenSucceeds()
        {
            // /api/preview answers 202 until the asset is catalogued; the
            // client retries once after the advertised delay.
            var handler = new FakeHandler()
                .Then(HttpStatusCode.Accepted, Json("{\"status\":\"pending\"}"), "application/json")
                .Then(HttpStatusCode.OK, new byte[] { 7 }, "image/avif");
            using var client = Client(handler);

            var path = await client.FetchImageAsync("preview", "lib:fresh.dng", CancellationToken.None);

            Assert.NotNull(path);
            Assert.Equal(2, handler.Requests.Count);
            Assert.All(handler.Requests, r =>
                Assert.Equal($"{Server}/api/preview/lib/fresh.dng", r.RequestUri!.AbsoluteUri));
        }

        // --- Directory listing: stays on /api/fs/dir (size/mtime/EXIF + absolute paths) ---

        [Fact]
        public async Task ListDirAsync_StaysOnFsDir_WithLimitAndCursor()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, Json(
                "{\"path\":\"/srv/lib/2024\",\"parent\":\"/srv/lib\",\"dirs\":[{\"name\":\"sub\",\"path\":\"/srv/lib/2024/sub\",\"mtime\":\"2024-01-02T03:04:05Z\"}]," +
                "\"images\":[{\"name\":\"a.CR2\",\"path\":\"/srv/lib/2024/a.CR2\",\"size\":123,\"ext\":\"cr2\",\"id\":\"abc\"," +
                "\"exif\":{\"camera_make\":\"Canon\",\"iso\":100}}],\"next_cursor\":\"c2\"}"), "application/json");
            using var client = Client(handler);

            var listing = await client.ListDirAsync("/srv/lib/2024", "c1", 500, CancellationToken.None);

            Assert.Equal(
                $"{Server}/api/fs/dir?path=%2Fsrv%2Flib%2F2024&limit=500&cursor=c1",
                Assert.Single(handler.Requests).RequestUri!.AbsoluteUri);
            Assert.NotNull(listing);
            Assert.Equal("c2", listing!.NextCursor);
            var dir = Assert.Single(listing.Dirs);
            Assert.Equal("/srv/lib/2024/sub", dir.Path);
            var image = Assert.Single(listing.Images);
            Assert.Equal(123, image.Size);
            Assert.Equal("Canon", image.Exif?.CameraMake);
            Assert.Equal(100, image.Exif?.Iso);
        }

        [Fact]
        public async Task ListDirAsync_TransportFailureIsNull_NotAThrow()
        {
            // Browsing runs from async-void UI handlers; an escaped
            // HttpRequestException would take the process down.
            var handler = new ThrowingHandler();
            using var client = Client(handler);

            Assert.Null(await client.ListDirAsync("/srv/lib", null, 500, CancellationToken.None));
        }

        private sealed class ThrowingHandler : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request, CancellationToken cancellationToken) =>
                throw new HttpRequestException("connection refused");
        }

        // --- Original bytes: stay on /api/fs/raw (#926 mirror failover) ---

        [Fact]
        public async Task OpenOriginalAsync_StaysOnFsRaw_ReturnsStreamableBody()
        {
            var body = new byte[10_000];
            new Random(1).NextBytes(body);
            var handler = new FakeHandler().Then(HttpStatusCode.OK, body, "application/octet-stream");
            using var client = Client(handler);

            using var response = await client.OpenOriginalAsync("/srv/lib/2024/a b.CR2", CancellationToken.None);

            var request = Assert.Single(handler.Requests);
            Assert.Equal($"{Server}/api/fs/raw?path=%2Fsrv%2Flib%2F2024%2Fa%20b.CR2", request.RequestUri!.AbsoluteUri);
            // No Range header: hydration asks for the whole file from 0 —
            // neither /api/fs/raw nor /api/image honours one.
            Assert.Null(request.Headers.Range);
            Assert.NotNull(response);
            Assert.Equal(body.Length, response!.Content.Headers.ContentLength);
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var sink = new MemoryStream();
            await stream.CopyToAsync(sink);
            Assert.Equal(body, sink.ToArray());
        }

        [Fact]
        public async Task OpenOriginalAsync_NonSuccessIsNull()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.NotFound, Json("{\"error\":\"no readable copy\"}"), "application/json");
            using var client = Client(handler);

            Assert.Null(await client.OpenOriginalAsync("/srv/lib/gone.CR2", CancellationToken.None));
        }

        [Fact]
        public async Task DownloadOriginalAsync_StaysOnFsRaw_StreamsToCacheWithProgress()
        {
            var body = new byte[3_000_000];
            new Random(2).NextBytes(body);
            var handler = new FakeHandler().Then(HttpStatusCode.OK, body, "application/octet-stream");
            using var client = Client(handler);
            var progress = new List<(long received, long total)>();

            var path = await client.DownloadOriginalAsync(
                "/srv/lib/2024/IMG_0001.CR2", body.Length, (r, t) => progress.Add((r, t)), CancellationToken.None);

            Assert.Equal(
                $"{Server}/api/fs/raw?path=%2Fsrv%2Flib%2F2024%2FIMG_0001.CR2",
                Assert.Single(handler.Requests).RequestUri!.AbsoluteUri);
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

            var first = await client.DownloadOriginalAsync("/srv/lib/x.dng", body.Length, null, CancellationToken.None);
            var second = await client.DownloadOriginalAsync("/srv/lib/x.dng", body.Length, null, CancellationToken.None);

            Assert.Equal(first, second);
            Assert.Single(handler.Requests);
        }
    }
}

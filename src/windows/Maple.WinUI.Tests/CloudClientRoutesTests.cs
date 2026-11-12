// CloudClientRoutesTests — the routes the Windows Maple Cloud client speaks
// after the #1325 cutover, pinned against a fake HttpMessageHandler through
// CloudClient's internal transport constructor (no server, no network).
//
// What moved: thumbnails and previews are fetched by `slug:relPath` address
// (GET /api/thumb/:slug/*, /api/preview/:slug/*), the unified routes the web
// grid reads, and the File Explorer sync root lists and hydrates by address
// (GET /api/folder/:slug/*, /api/image/:slug/*, /api/folders/:id/file —
// #5852). What stayed path-addressed, and why, is in the per-method comments
// in Services/Cloud/CloudClient.*.cs: the in-app browser's directory listing
// (GET /api/fs/dir) and download-to-edit (GET /api/fs/raw). These tests pin
// both halves so a future route swap is a deliberate test change, not a
// silent one.

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

        [Fact]
        public async Task Inspector_UsesExistingAssetDetailRouteAndEscapesPath()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK,
                Json("{\"description\":\"Golden hour\",\"xmp_mtime\":1700000060}"), "application/json");
            using var client = Client(handler);
            var metadata = await client.GetInspectorMetadataAsync("/photos/A & B/#1.dng", CancellationToken.None);
            Assert.Equal("Golden hour", metadata!.Description);
            Assert.Equal(1700000060L, metadata.XmpModifiedSeconds);
            Assert.Equal("/api/assets/by-fspath?path=%2Fphotos%2FA%20%26%20B%2F%231.dng",
                handler.Requests.Single().RequestUri!.PathAndQuery);
        }

        [Fact]
        public async Task Inspector_UnindexedAssetIsUnavailableRatherThanEmptySuccess()
        {
            using var client = Client(new FakeHandler().Then(HttpStatusCode.NotFound));
            Assert.Null(await client.GetInspectorMetadataAsync("/missing.dng", CancellationToken.None));
        }

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
        public async Task FetchImageAsync_SecondCallRevalidatesAndReusesIdenticalPixels()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, new byte[] { 4, 5 }, "image/avif")
                .Then(HttpStatusCode.OK, new byte[] { 4, 5 }, "image/avif");
            using var client = Client(handler);

            var first = await client.FetchImageAsync("thumb", "lib:x.dng", CancellationToken.None);
            var second = await client.FetchImageAsync("thumb", "lib:x.dng", CancellationToken.None);

            Assert.Equal(first, second);
            Assert.Equal(2, handler.Requests.Count);
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

        // --- Unified folder listing (File Explorer sync root, #5852) ---

        [Fact]
        public async Task ListFolderAsync_HitsUnifiedFolderRoute_SegmentEncodedWithLimitAndCursor()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, Json(
                "{\"address\":\"photos:2024/a b\",\"folders\":[{\"name\":\"sub\",\"address\":\"photos:2024/a b/sub\",\"path\":\"/srv/photos/2024/a b/sub\",\"size\":4096,\"mtime\":\"2024-01-02T03:04:05.000Z\",\"ext\":\"\"}]," +
                "\"images\":[{\"name\":\"x.CR2\",\"address\":\"photos:2024/a b/x.CR2\",\"size\":123,\"mtime\":\"2024-01-02T03:04:05.000Z\",\"ext\":\"cr2\",\"mapleId\":null,\"indexed\":false}]," +
                "\"files\":[{\"name\":\"clip.mov\",\"address\":\"photos:2024/a b/clip.mov\",\"size\":9,\"mtime\":\"2024-01-02T03:04:05.000Z\",\"ext\":\"mov\"}]," +
                "\"sidecars\":[{\"name\":\"x.xmp\",\"address\":\"photos:2024/a b/x.xmp\",\"size\":7,\"mtime\":\"2024-01-02T03:04:05.000Z\",\"ext\":\"xmp\",\"asset_id\":\"abc\"}]," +
                "\"next_cursor\":\"c2\"}"), "application/json");
            using var client = Client(handler);

            var listing = await client.ListFolderAsync("photos:2024/a b", "c1", 500, CancellationToken.None);

            Assert.Equal(
                $"{Server}/api/folder/photos/2024/a%20b?limit=500&cursor=c1",
                Assert.Single(handler.Requests).RequestUri!.AbsoluteUri);
            Assert.NotNull(listing);
            Assert.Equal("c2", listing!.NextCursor);
            Assert.Equal("photos:2024/a b/sub", Assert.Single(listing.Folders).Address);
            Assert.Equal(123, Assert.Single(listing.Images).Size);
            Assert.Equal("clip.mov", Assert.Single(listing.Files).Name);
            Assert.Equal(7, Assert.Single(listing.Sidecars).Size);
        }

        [Fact]
        public async Task ListFolderAsync_LibraryRoot_HasNoTrailingSegment()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, Json("{\"address\":\"photos:\"}"), "application/json");
            using var client = Client(handler);

            var listing = await client.ListFolderAsync("photos:", null, 500, CancellationToken.None);

            Assert.Equal($"{Server}/api/folder/photos?limit=500", Assert.Single(handler.Requests).RequestUri!.AbsoluteUri);
            Assert.NotNull(listing);
            Assert.Empty(listing!.Folders);
            Assert.Null(listing.NextCursor);
        }

        [Fact]
        public async Task ListFolderAsync_FailureIsNull_NotAThrow()
        {
            using var refused = Client(new ThrowingHandler());
            Assert.Null(await refused.ListFolderAsync("photos:", null, 500, CancellationToken.None));

            using var notFound = Client(new FakeHandler().Then(HttpStatusCode.NotFound, Json("{\"error\":\"x\"}"), "application/json"));
            Assert.Null(await notFound.ListFolderAsync("photos:gone", null, 500, CancellationToken.None));
        }

        // --- Library file bytes (File Explorer hydration, #5852) ---

        private static async Task<byte[]> ReadAllAsync(HttpResponseMessage response)
        {
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var sink = new MemoryStream();
            await stream.CopyToAsync(sink);
            return sink.ToArray();
        }

        [Fact]
        public async Task OpenLibraryFileAsync_Image_StreamsFromUnifiedImageRoute()
        {
            var body = new byte[10_000];
            new Random(1).NextBytes(body);
            var handler = new FakeHandler().Then(HttpStatusCode.OK, body, "image/x-canon-cr2");
            using var client = Client(handler);

            using var response = await client.OpenLibraryFileAsync("photos:2024/a b.CR2", CancellationToken.None);

            var request = Assert.Single(handler.Requests);
            Assert.Equal($"{Server}/api/image/photos/2024/a%20b.CR2", request.RequestUri!.AbsoluteUri);
            // Whole file from 0: the FULL hydration policy never asks for less.
            Assert.Null(request.Headers.Range);
            Assert.NotNull(response);
            Assert.Equal(body, await ReadAllAsync(response!));
        }

        [Fact]
        public async Task OpenLibraryFileAsync_415_FallsBackToTheLibraryFileRoute()
        {
            var body = new byte[] { 1, 2, 3 };
            var handler = new FakeHandler()
                .Then(HttpStatusCode.UnsupportedMediaType, Json("{\"error\":\"Unsupported file extension: \\\"mov\\\"\"}"), "application/json")
                .Then(HttpStatusCode.OK, Json("[{\"id\":\"0123456789abcdef01234567\",\"slug\":\"photos\",\"path\":\"/srv/photos\"}]"), "application/json")
                .Then(HttpStatusCode.OK, body, "application/octet-stream");
            using var client = Client(handler);

            using var response = await client.OpenLibraryFileAsync("photos:2024/clip a.mov", CancellationToken.None);

            Assert.Equal(
                new[]
                {
                    $"{Server}/api/image/photos/2024/clip%20a.mov",
                    $"{Server}/api/folders",
                    $"{Server}/api/folders/0123456789abcdef01234567/file?path=2024%2Fclip%20a.mov",
                },
                handler.Requests.Select(r => r.RequestUri!.AbsoluteUri));
            Assert.NotNull(response);
            Assert.Equal(body, await ReadAllAsync(response!));
        }

        [Fact]
        public async Task OpenLibraryFileAsync_415ForAnUnknownLibrary_IsNull()
        {
            var handler = new FakeHandler()
                .Then(HttpStatusCode.UnsupportedMediaType)
                .Then(HttpStatusCode.OK, Json("[{\"id\":\"x\",\"slug\":\"other\",\"path\":\"/srv/other\"}]"), "application/json");
            using var client = Client(handler);

            Assert.Null(await client.OpenLibraryFileAsync("photos:a.xmp", CancellationToken.None));
            Assert.Equal(2, handler.Requests.Count);
        }

        [Fact]
        public async Task OpenLibraryFileAsync_NonSuccessIsNull_WithoutFallback()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.NotFound, Json("{\"error\":\"File not found\"}"), "application/json");
            using var client = Client(handler);

            Assert.Null(await client.OpenLibraryFileAsync("photos:gone.CR2", CancellationToken.None));
            Assert.Single(handler.Requests);
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

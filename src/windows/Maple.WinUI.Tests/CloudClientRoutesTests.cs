// CloudClientRoutesTests — the routes the Windows Maple Cloud client speaks,
// pinned against a fake HttpMessageHandler through CloudClient's internal
// transport constructor (no server, no network). Browse, the sidebar tree and
// File Explorer list through the unified folder route, and the editor, export,
// share and File Explorer read originals through the unified image route
// (File Explorer falling back to the library file route on HTTP 415).

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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

        // --- File Explorer hydration: unified image route and file fallback ---

        [Fact]
        public async Task OpenOriginalAsync_UsesUnifiedImageRoute_ReturnsStreamableBody()
        {
            var body = new byte[10_000];
            new Random(1).NextBytes(body);
            var handler = new FakeHandler().Then(HttpStatusCode.OK, body, "application/octet-stream");
            using var client = Client(handler);

            using var response = await client.OpenOriginalAsync("lib:2024/a b.CR2", "folder1", "2024/a b.CR2", CancellationToken.None);

            var request = Assert.Single(handler.Requests);
            Assert.Equal($"{Server}/api/image/lib/2024/a%20b.CR2", request.RequestUri!.AbsoluteUri);
            // No Range header: hydration asks for the whole file from 0.
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

            Assert.Null(await client.OpenOriginalAsync("lib:gone.CR2", "folder1", "gone.CR2", CancellationToken.None));
            Assert.Single(handler.Requests);
        }

        [Fact]
        public async Task OpenOriginalAsync_UnsupportedMediaFallsBackToLibraryFileRoute()
        {
            var handler = new FakeHandler()
                .Then(HttpStatusCode.UnsupportedMediaType)
                .Then(HttpStatusCode.OK, new byte[] { 1, 2, 3 }, "application/octet-stream");
            using var client = Client(handler);

            using var response = await client.OpenOriginalAsync("lib:Trip A/clip.mov", "folder 1", "Trip A/clip.mov", CancellationToken.None);

            Assert.Equal($"{Server}/api/image/lib/Trip%20A/clip.mov", handler.Requests[0].RequestUri!.AbsoluteUri);
            Assert.Equal($"{Server}/api/folders/folder%201/file?path=Trip%20A%2Fclip.mov", handler.Requests[1].RequestUri!.AbsoluteUri);
            Assert.Equal(new byte[] { 1, 2, 3 }, await response!.Content.ReadAsByteArrayAsync());
        }

        [Theory]
        [InlineData("{\"error\":\"Asset is already trashed\",\"state\":\"trashed\"}", true)]
        [InlineData("{\"error\":\"Asset is not trashed\"}", false)]
        public async Task TrashAssetAsync_UsesTrashIntent_AndOnlyAcceptsAlreadyTrashedConflict(string body, bool expected)
        {
            var handler = new FakeHandler().Then(HttpStatusCode.Conflict, Json(body), "application/json");
            using var client = Client(handler);

            var result = await client.TrashAssetAsync("asset/one", CancellationToken.None);

            Assert.Equal(expected, result);
            Assert.Equal("DELETE", Assert.Single(handler.Requests).Method.Method);
            Assert.Equal("/api/assets/asset%2Fone?intent=trash", handler.Requests[0].RequestUri!.PathAndQuery);
        }

        [Theory]
        [InlineData("{\"total\":2,\"succeeded\":1,\"failed\":1,\"items\":[]}")]
        [InlineData("{}")]
        public async Task TrashCloudFolderAsync_RefusesAPartialOrUnreadableBatch(string body)
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, Json(body), "application/json");
            using var client = Client(handler);

            Assert.False(await client.TrashCloudFolderAsync("folder-id", "2026", CancellationToken.None));
        }

        [Fact]
        public async Task ResolveAssetAddressAsync_ReportsWhetherTheAssetLivesInOnePlace()
        {
            var handler = new FakeHandler()
                .Then(HttpStatusCode.OK, Json("{\"id\":\"a\",\"fileinfo\":[{\"path\":\"\",\"filename\":\"a.dng\"},{\"path\":\"old\",\"filename\":\"a.dng\",\"deleted_at\":\"2026-01-01T00:00:00Z\"}]}"), "application/json")
                .Then(HttpStatusCode.OK, Json("{\"id\":\"b\",\"fileinfo\":[{\"path\":\"\",\"filename\":\"b.dng\"},{\"path\":\"copy\",\"filename\":\"b.dng\"}]}"), "application/json");
            using var client = Client(handler);

            Assert.True((await client.ResolveAssetAddressAsync("lib:a.dng", CancellationToken.None))!.HasSingleLiveLocation);
            Assert.False((await client.ResolveAssetAddressAsync("lib:copy/b.dng", CancellationToken.None))!.HasSingleLiveLocation);
        }

        [Fact]
        public async Task TrashCloudFolderAsync_UsesLibraryRelativeTargetHeader()
        {
            var handler = new FakeHandler().Then(
                HttpStatusCode.OK, Json("{\"total\":2,\"succeeded\":2,\"failed\":0,\"items\":[]}"), "application/json");
            using var client = Client(handler);

            Assert.True(await client.TrashCloudFolderAsync("folder-id", "2026/été 100%", CancellationToken.None));

            var request = Assert.Single(handler.Requests);
            Assert.Equal("POST", request.Method.Method);
            Assert.Equal("/api/folders/folder-id/trash-folder", request.RequestUri!.PathAndQuery);
            var header = Assert.Single(request.Headers.GetValues("X-Maple-Target-Path"));
            Assert.Equal("2026%2F%C3%A9t%C3%A9%20100%25", header);
            Assert.Equal("2026/été 100%", Uri.UnescapeDataString(header));
        }
    }
}

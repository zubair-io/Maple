// GET /api/folder/:slug/* behind Browse and the sidebar tree (#6104), pinned
// against fake transports. The response shape is the one
// src/api/src/library/folder-listing.ts writes.

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
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class CloudUnifiedBrowseRoutesTests : IDisposable
    {
        private const string Server = "https://maple.example.test";
        private readonly string _cacheDir = Path.Combine(
            Path.GetTempPath(), "maple-cloudbrowse-tests-" + Guid.NewGuid().ToString("N"));

        public void Dispose()
        {
            try { Directory.Delete(_cacheDir, recursive: true); } catch { /* best effort */ }
        }

        private CloudClient Client(HttpMessageHandler handler) => new(Server, handler, _cacheDir);

        private static byte[] Json(string text) => Encoding.UTF8.GetBytes(text);

        // --- Folder listing: unified address route (Browse, tree, File Explorer) ---

        // A page of GET /api/folder/:slug/* as the server writes it
        // (src/api/src/library/folder-listing.ts; the field set is the one
        // src/api/src/routes/library/folder.enriched.test.ts pins), including
        // the fields this client does not read.
        private const string FirstPage =
            "{\"address\":\"photos:2024\",\"parent\":\"photos:\",\"path\":\"/srv/photos/2024\",\"realPath\":\"/mnt/real/2024\"," +
            "\"parentPath\":\"/srv/photos\"," +
            "\"folders\":[{\"name\":\"Trip A\",\"address\":\"photos:2024/Trip A\",\"path\":\"/srv/photos/2024/Trip A\"," +
            "\"mtime\":\"2026-01-02T03:04:05.000Z\",\"size\":4096,\"ext\":\"\",\"realPath\":\"/mnt/real/2024/Trip A\"}]," +
            "\"images\":[" +
            "{\"name\":\"frame.dng\",\"address\":\"photos:2024/frame.dng\",\"path\":\"/srv/photos/2024/frame.dng\"," +
            "\"mtime\":\"2023-11-14T22:13:20.000Z\",\"size\":14,\"ext\":\"dng\",\"mapleId\":null,\"indexed\":true,\"id\":\"a1b2\"," +
            "\"exif\":{\"captured_at\":\"2023-11-14T20:00:00.000Z\",\"captured_year\":2023,\"captured_month\":11," +
            "\"camera_make\":\"Hasselblad\",\"camera_model\":\"L3D-100c\",\"lens\":\"24mm f/1.5\",\"iso\":100,\"aperture\":2.8," +
            "\"shutter\":\"1/250\",\"focal_length\":24,\"width\":100},\"width\":100,\"height\":80," +
            "\"capturedAt\":\"2023-11-14T20:00:00.000Z\",\"edited\":true,\"rating\":4,\"flag\":\"pick\",\"colorLabel\":\"red\",\"thumbVersion\":\"1700000000-1\"}," +
            "{\"name\":\"new.CR2\",\"address\":\"photos:2024/new.CR2\",\"path\":\"/srv/photos/2024/new.CR2\"," +
            "\"mtime\":\"2024-03-04T05:06:07.000Z\",\"size\":9,\"ext\":\"cr2\",\"mapleId\":null,\"indexed\":false}," +
            "{\"name\":\"clip.mov\",\"address\":\"photos:2024/clip.mov\",\"path\":\"/srv/photos/2024/clip.mov\"," +
            "\"mtime\":\"2024-03-04T05:06:07.000Z\",\"size\":77,\"ext\":\"mov\",\"isVideo\":true,\"mapleId\":null,\"indexed\":true,\"id\":\"c3\",\"exif\":null}]," +
            "\"files\":[{\"name\":\"notes.txt\",\"address\":\"photos:2024/notes.txt\",\"path\":\"/srv/photos/2024/notes.txt\",\"mtime\":\"2024-03-04T05:06:07.000Z\",\"size\":3,\"ext\":\"txt\"}]," +
            "\"sidecars\":[{\"name\":\"frame.xmp\",\"address\":\"photos:2024/frame.xmp\",\"path\":\"/srv/photos/2024/frame.xmp\",\"mtime\":\"2024-03-04T05:06:07.000Z\",\"size\":64,\"ext\":\"xmp\",\"asset_id\":\"a1b2\"}]," +
            "\"next_cursor\":\"eyJvZmZzZXQiOjUwMH0\"}";

        [Fact]
        public async Task ListFolderAddressAsync_BuildsTheUnifiedRequest_WithoutStack()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, Json(FirstPage), "application/json")
                .Then(HttpStatusCode.OK, Json("{}"), "application/json")
                .Then(HttpStatusCode.OK, Json("{}"), "application/json");
            using var client = Client(handler);

            await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None);
            await client.ListFolderAddressAsync("photos:2024", "eyJvZmZzZXQiOjUwMH0", 500, CancellationToken.None);
            await client.ListFolderAddressAsync("photos:", null, 500, CancellationToken.None);

            Assert.All(handler.Requests, r => Assert.Equal(HttpMethod.Get, r.Method));
            Assert.Equal(
                new[]
                {
                    $"{Server}/api/folder/photos/2024?limit=500",
                    $"{Server}/api/folder/photos/2024?limit=500&cursor=eyJvZmZzZXQiOjUwMH0",
                    $"{Server}/api/folder/photos?limit=500",
                },
                handler.Requests.Select(r => r.RequestUri!.AbsoluteUri));
            // Browse folds RAW+JPEG pairs itself; the server must list every file.
            Assert.All(handler.Requests, r => Assert.DoesNotContain("stack", r.RequestUri!.Query));
        }

        [Fact]
        public async Task ListFolderAddressAsync_EncodesEachSegmentAndTheCursor()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, Json("{}"), "application/json");
            using var client = Client(handler);

            await client.ListFolderAddressAsync("my lib:a b/c#d/été", "next + page", 2000, CancellationToken.None);

            Assert.Equal(
                $"{Server}/api/folder/my%20lib/a%20b/c%23d/%C3%A9t%C3%A9?limit=2000&cursor=next%20%2B%20page",
                Assert.Single(handler.Requests).RequestUri!.AbsoluteUri);
        }

        [Theory]
        [InlineData(0)]
        [InlineData(2001)]
        public async Task ListFolderAddressAsync_RefusesALimitTheServerWouldClamp(int limit)
        {
            using var client = Client(new FakeHandler().Then(HttpStatusCode.OK, Json("{}"), "application/json"));
            await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
                client.ListFolderAddressAsync("photos:", null, limit, CancellationToken.None));
        }

        [Fact]
        public async Task ListFolderAddressAsync_DeserializesEveryEntryKind()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, Json(FirstPage), "application/json");
            using var client = Client(handler);

            var listing = await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None);

            Assert.Equal("eyJvZmZzZXQiOjUwMH0", listing!.NextCursor);
            var folder = Assert.Single(listing.Folders);
            Assert.Equal(("Trip A", "photos:2024/Trip A", "/srv/photos/2024/Trip A"), (folder.Name, folder.Address, folder.Path));
            Assert.Equal(new[] { "frame.dng", "new.CR2", "clip.mov" }, listing.Images.Select(i => i.Name));
            Assert.Single(listing.Files);
            Assert.Single(listing.Sidecars);
        }

        [Fact]
        public async Task ListFolderAddressAsync_ImagesMapToTheSameGridItemsTheLegacyListingProduced()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.OK, Json(FirstPage), "application/json");
            using var client = Client(handler);
            var listing = await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None);

            var indexed = CloudPhotoMapper.FromDirectory(listing!.Images[0]);
            Assert.Equal("photos:2024/frame.dng", indexed.CloudAddress);
            Assert.Equal("/srv/photos/2024/frame.dng", indexed.FilePath);
            Assert.Equal("frame.dng", indexed.FileName);
            Assert.Equal("DNG", indexed.Format);
            Assert.Equal(14, indexed.FileSizeBytes);
            Assert.Equal(new DateTime(2023, 11, 14, 22, 13, 20, DateTimeKind.Utc), indexed.FileModifiedUtc);
            Assert.Equal(new DateTime(2023, 11, 14, 20, 0, 0, DateTimeKind.Utc), indexed.CaptureDate!.Value.ToUniversalTime());
            Assert.Equal("Hasselblad L3D-100c", indexed.CameraModel);
            Assert.Equal("24mm f/1.5", indexed.LensInfo);
            Assert.Equal("ISO 100", indexed.IsoDisplay);
            Assert.Equal("1/250", indexed.ShutterSpeed);
            Assert.Equal(24.0, indexed.FocalLengthMm);
            // The listing's culling fields are not read: the grid keeps its
            // defaults until the sidecar loads, as it did on the legacy route.
            Assert.Equal(0, indexed.Rating);
            Assert.Equal("none", indexed.FlagStatus);
            Assert.Null(indexed.ColorLabel);

            var unindexed = CloudPhotoMapper.FromDirectory(listing.Images[1]);
            Assert.Equal("CR2", unindexed.Format);
            Assert.Equal(9, unindexed.FileSizeBytes);
            Assert.Null(unindexed.CaptureDate);
            Assert.Equal("—", unindexed.CameraModel);
            Assert.Equal(new DateTime(2024, 3, 4, 5, 6, 7, DateTimeKind.Utc), unindexed.FileModifiedUtc);

            var video = CloudPhotoMapper.FromDirectory(listing.Images[2]);
            Assert.Equal("MOV", video.Format);
            Assert.Null(video.CaptureDate);
            Assert.Equal("—", video.LensInfo);
        }

        [Fact]
        public async Task ListFolderAddressAsync_PagesAreRequestedByTheCursorTheServerReturned()
        {
            var handler = new FakeHandler()
                .Then(HttpStatusCode.OK, Json(FirstPage), "application/json")
                .Then(HttpStatusCode.OK, Json("{\"images\":[{\"name\":\"z.dng\",\"address\":\"photos:2024/z.dng\",\"size\":1}]}"), "application/json");
            using var client = Client(handler);

            var first = await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None);
            var second = await client.ListFolderAddressAsync("photos:2024", first!.NextCursor, 500, CancellationToken.None);

            Assert.Equal($"{Server}/api/folder/photos/2024?limit=500&cursor={first.NextCursor}",
                handler.Requests[1].RequestUri!.AbsoluteUri);
            Assert.Null(second!.NextCursor);
            // The last page carries no cursor, which with no cap, failure or
            // cancellation is what makes a listing complete for RAW+JPEG folding.
            Assert.False(RawJpegStackFold.IsCloudListingComplete(false, false, false, first.NextCursor));
            Assert.True(RawJpegStackFold.IsCloudListingComplete(false, false, false, second.NextCursor));
        }

        [Fact]
        public async Task ListFolderAddressAsync_AFailedLaterPageIsNullSoTheListingStaysIncomplete()
        {
            var handler = new FakeHandler()
                .Then(HttpStatusCode.OK, Json(FirstPage), "application/json")
                .Then(HttpStatusCode.InternalServerError, Json("{\"error\":\"boom\"}"), "application/json");
            using var client = Client(handler);

            var first = await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None);
            var second = await client.ListFolderAddressAsync("photos:2024", first!.NextCursor, 500, CancellationToken.None);

            Assert.NotNull(first);
            Assert.Null(second);
            Assert.False(RawJpegStackFold.IsCloudListingComplete(false, pageFailed: second == null, false, null));
        }

        [Theory]
        [InlineData(HttpStatusCode.Forbidden)]
        [InlineData(HttpStatusCode.NotFound)]
        [InlineData(HttpStatusCode.BadRequest)]
        [InlineData(HttpStatusCode.InternalServerError)]
        [InlineData(HttpStatusCode.ServiceUnavailable)]
        public async Task ListFolderAddressAsync_AnyNonSuccessStatusIsNull(HttpStatusCode status)
        {
            var handler = new FakeHandler().Then(status, Json("{\"error\":\"no\"}"), "application/json");
            using var client = Client(handler);

            Assert.Null(await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None));
            Assert.Single(handler.Requests);
        }

        [Fact]
        public async Task ListFolderAddressAsync_UnauthorizedRefreshesTheTokenOnceAndRetries()
        {
            var handler = new FakeHandler()
                .Then(HttpStatusCode.Unauthorized)
                .Then(HttpStatusCode.OK, Json("{\"access_token\":\"fresh\"}"), "application/json")
                .Then(HttpStatusCode.OK, Json(FirstPage), "application/json");
            using var client = Client(handler);

            var listing = await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None);

            Assert.NotNull(listing);
            Assert.Equal(
                new[] { "/api/folder/photos/2024", "/api/auth/refresh", "/api/folder/photos/2024" },
                handler.Requests.Select(r => r.RequestUri!.AbsolutePath));
            Assert.Equal("fresh", handler.Requests[2].Headers.Authorization!.Parameter);
        }

        [Fact]
        public async Task ListFolderAddressAsync_UnauthorizedAfterAFailedRefreshIsNull()
        {
            var handler = new FakeHandler().Then(HttpStatusCode.Unauthorized);
            using var client = Client(handler);

            Assert.Null(await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None));
        }

        [Fact]
        public async Task ListFolderAddressAsync_UnreadableBodyIsNull()
        {
            using var client = Client(new FakeHandler().Then(HttpStatusCode.OK, Json("<html>"), "text/html"));
            Assert.Null(await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None));
        }

        [Fact]
        public async Task ListFolderAddressAsync_TransportFailureIsNull_NotAThrow()
        {
            // Browsing runs from async-void UI handlers; an escaped
            // HttpRequestException would take the process down.
            using var client = Client(new ThrowingHandler(new HttpRequestException("connection refused")));
            Assert.Null(await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None));
        }

        [Fact]
        public async Task ListFolderAddressAsync_ClientTimeoutIsNull()
        {
            // HttpClient's own 30s timeout surfaces as a TaskCanceledException
            // while the caller's token is still unsignalled.
            using var client = Client(new ThrowingHandler(new TaskCanceledException("timed out")));
            Assert.Null(await client.ListFolderAddressAsync("photos:2024", null, 500, CancellationToken.None));
        }

        [Fact]
        public async Task ListFolderAddressAsync_CancellationPropagates()
        {
            var handler = new HangingHandler();
            using var client = Client(handler);
            using var cts = new CancellationTokenSource();

            var listing = client.ListFolderAddressAsync("photos:2024", null, 500, cts.Token);
            await handler.Started.Task;
            cts.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => listing!);
        }
    }
}

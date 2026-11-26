using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudClientFolderListingStreamTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private static byte[] ListingPayload(int images)
    {
        var listing = new
        {
            folders = Enumerable.Range(0, 3).Select(i => new
            {
                name = $"dir-{i}", address = $"lib:Trip/dir-{i}", path = $"/photos/trip/dir-{i}", size = 0L, mtime = "2026-11-01T10:00:00Z",
            }),
            images = Enumerable.Range(0, images).Select(i => new
            {
                name = $"IMG_{i:D5}.CR3", address = $"lib:Trip/IMG_{i:D5}.CR3", path = $"/photos/trip/IMG_{i:D5}.CR3",
                size = 25_000_000L + i, mtime = "2026-11-02T08:30:00Z", ext = "cr3", id = $"asset-{i}",
                exif = new { camera_make = "TestMake", camera_model = "TestModel", lens = "TestLens", iso = 100 + i },
            }),
            files = Array.Empty<object>(),
            sidecars = Array.Empty<object>(),
            next_cursor = "cursor-é-1",
        };
        return JsonSerializer.SerializeToUtf8Bytes(listing);
    }

    private static string Canonical(CloudFolderListing? listing) => JsonSerializer.Serialize(listing, Web);

    private static async Task<(CloudFolderListing? Listing, string? AcceptEncoding)> ListThroughLoopback(
        byte[] body, bool gzip, HttpStatusCode status = HttpStatusCode.OK)
    {
        using var listener = new HttpListener();
        var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        string? acceptEncoding = null;
        var server = Task.Run(async () =>
        {
            var context = await listener.GetContextAsync();
            acceptEncoding = context.Request.Headers["Accept-Encoding"];
            context.Response.StatusCode = (int)status;
            context.Response.ContentType = "application/json";
            var payload = body;
            if (gzip)
            {
                context.Response.AddHeader("Content-Encoding", "gzip");
                using var compressed = new MemoryStream();
                await using (var zip = new GZipStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
                    await zip.WriteAsync(body);
                payload = compressed.ToArray();
            }
            context.Response.ContentLength64 = payload.Length;
            await context.Response.OutputStream.WriteAsync(payload);
            context.Response.Close();
        });
        var cache = Path.Combine(Path.GetTempPath(), "maple-folderlisting-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var client = new CloudClient($"http://127.0.0.1:{port}", CloudClient.CreateHandler(), cache);
            var listing = await client.ListFolderAddressAsync("lib:Trip", null, 500, CancellationToken.None);
            await server;
            return (listing, acceptEncoding);
        }
        finally
        {
            listener.Stop();
            if (Directory.Exists(cache)) Directory.Delete(cache, recursive: true);
        }
    }

    [Fact]
    public async Task Plain_listing_maps_every_field()
    {
        var (listing, _) = await ListThroughLoopback(ListingPayload(40), gzip: false);
        Assert.NotNull(listing);
        Assert.Equal(3, listing!.Folders.Length);
        Assert.Equal("dir-2", listing.Folders[2].Name);
        Assert.Equal("lib:Trip/dir-2", listing.Folders[2].Address);
        Assert.Equal(40, listing.Images.Length);
        Assert.Equal("IMG_00039.CR3", listing.Images[39].Name);
        Assert.Equal("lib:Trip/IMG_00039.CR3", listing.Images[39].Address);
        Assert.Equal(25_000_039L, listing.Images[39].Size);
        Assert.Equal("cr3", listing.Images[39].Ext);
        Assert.Equal("asset-39", listing.Images[39].Id);
        Assert.Equal(139, listing.Images[39].Exif!.Iso);
        Assert.Equal("TestMake", listing.Images[39].Exif!.CameraMake);
        Assert.Equal("cursor-é-1", listing.NextCursor);
    }

    [Fact]
    public async Task Compressed_multi_megabyte_listing_matches_the_oracle_model()
    {
        var payload = ListingPayload(50_000);
        Assert.True(payload.Length > 4_000_000);
        var oracle = JsonSerializer.Deserialize<CloudFolderListing>(payload, Web);

        var (listing, acceptEncoding) = await ListThroughLoopback(payload, gzip: true);

        Assert.Contains("gzip", acceptEncoding);
        Assert.Equal(50_000, listing!.Images.Length);
        Assert.Equal(Canonical(oracle), Canonical(listing));
    }

    [Fact]
    public async Task Non_success_status_gives_null()
    {
        var (listing, _) = await ListThroughLoopback(ListingPayload(2), gzip: false, HttpStatusCode.InternalServerError);
        Assert.Null(listing);
    }

    [Fact]
    public async Task Malformed_json_gives_null_not_an_exception()
    {
        var (listing, _) = await ListThroughLoopback(Encoding.UTF8.GetBytes("{\"folders\": [ {"), gzip: false);
        Assert.Null(listing);
    }

    [Fact]
    public async Task Empty_body_gives_null()
    {
        var (listing, _) = await ListThroughLoopback(Array.Empty<byte>(), gzip: false);
        Assert.Null(listing);
    }

    private static long AllocatedBy(Action action)
    {
        var before = GC.GetAllocatedBytesForCurrentThread();
        action();
        return GC.GetAllocatedBytesForCurrentThread() - before;
    }

    private static CloudFolderListing? ReadThroughClient(byte[] payload)
    {
        using var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(payload) };
        var read = CloudClient.ReadJsonAsync<CloudFolderListing>(response, CancellationToken.None);
        Assert.True(read.IsCompleted, "the read left the measuring thread, so its allocations are not counted");
        return read.GetAwaiter().GetResult();
    }

    [Fact]
    public void Reading_the_body_does_not_materialise_it_as_a_string()
    {
        var warmUp = ListingPayload(10);
        ReadThroughClient(warmUp);
        JsonSerializer.Deserialize<CloudFolderListing>(warmUp, Web);
        var payload = ListingPayload(50_000);

        var modelOnly = AllocatedBy(() => JsonSerializer.Deserialize<CloudFolderListing>(payload, Web));
        var throughClient = AllocatedBy(() => Assert.Equal(50_000, ReadThroughClient(payload)!.Images.Length));

        Assert.True(throughClient < modelOnly + payload.Length,
            $"reading allocated {throughClient} bytes, the model alone {modelOnly}, for a {payload.Length}-byte body");
    }
}

using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudClientCompressionTests
{
    [Fact]
    public void Production_handler_decodes_every_encoding_the_server_can_send()
    {
        using var handler = CloudClient.CreateHandler();
        Assert.Equal(DecompressionMethods.All, handler.AutomaticDecompression);
        Assert.True(handler.UseCookies);
        Assert.NotNull(handler.CookieContainer);
    }

    [Fact]
    public async Task Compressed_listing_is_requested_and_read_through_the_client()
    {
        var libraries = Enumerable.Range(0, 200).Select(index => new
        {
            id = $"library-{index}", slug = $"slug-{index}", path = $"/photos/{index}", label = (string?)null, file_count = index,
        }).ToArray();
        var plain = JsonSerializer.SerializeToUtf8Bytes(libraries);
        using var listener = new HttpListener();
        var port = FreePort();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        string? acceptEncoding = null;
        var server = Task.Run(async () =>
        {
            var context = await listener.GetContextAsync();
            acceptEncoding = context.Request.Headers["Accept-Encoding"];
            context.Response.ContentType = "application/json";
            context.Response.AddHeader("Content-Encoding", "gzip");
            using var compressed = new MemoryStream();
            await using (var gzip = new GZipStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
                await gzip.WriteAsync(plain);
            context.Response.ContentLength64 = compressed.Length;
            await context.Response.OutputStream.WriteAsync(compressed.ToArray());
            context.Response.Close();
        });
        var cache = Path.Combine(Path.GetTempPath(), "maple-compress-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var client = new CloudClient($"http://127.0.0.1:{port}", CloudClient.CreateHandler(), cache);
            var folders = await client.GetFoldersAsync(CancellationToken.None);
            await server;
            Assert.NotNull(folders);
            Assert.Equal(200, folders!.Length);
            Assert.Equal("slug-199", folders[199].Slug);
            Assert.Contains("gzip", acceptEncoding);
            Assert.Contains("br", acceptEncoding);
        }
        finally
        {
            listener.Stop();
            if (Directory.Exists(cache)) Directory.Delete(cache, recursive: true);
        }
    }

    private static int FreePort()
    {
        var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }
}

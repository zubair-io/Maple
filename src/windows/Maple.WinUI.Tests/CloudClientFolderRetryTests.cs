using System.Net;
using System.Text;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudClientFolderRetryTests : IDisposable
{
    private const string Listing =
        "{\"folders\":[],\"images\":[{\"name\":\"a.CR2\",\"address\":\"lib:a.CR2\"}],\"next_cursor\":\"c2\"}";
    private const string Conflict = "{\"error\":\"Folder changed while it was being listed; retry.\"}";

    private readonly string _cache = Path.Combine(
        Path.GetTempPath(), "maple-folder-retry-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_cache, recursive: true); } catch { }
    }

    private sealed class Scripted : IDisposable
    {
        private readonly HttpListener _listener = new();
        private readonly Task _loop;
        private readonly (int Status, string Body)[] _answers;
        private readonly List<string> _targets = new();

        public Scripted(params (int Status, string Body)[] answers)
        {
            _answers = answers;
            var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Origin = $"http://127.0.0.1:{port}";
            _listener.Prefixes.Add(Origin + "/");
            _listener.Start();
            _loop = Task.Run(Serve);
        }

        public string Origin { get; }

        public IReadOnlyList<string> Targets { get { lock (_targets) return _targets.ToArray(); } }

        private async Task Serve()
        {
            while (_listener.IsListening)
            {
                HttpListenerContext context;
                try { context = await _listener.GetContextAsync(); }
                catch (Exception ex) when (ex is HttpListenerException or ObjectDisposedException) { return; }
                int index;
                lock (_targets)
                {
                    _targets.Add(context.Request.Url!.PathAndQuery);
                    index = Math.Min(_targets.Count, _answers.Length) - 1;
                }
                var (status, body) = _answers[index];
                var bytes = Encoding.UTF8.GetBytes(body);
                context.Response.StatusCode = status;
                context.Response.ContentType = "application/json";
                context.Response.ContentLength64 = bytes.Length;
                await context.Response.OutputStream.WriteAsync(bytes);
                context.Response.Close();
            }
        }

        public void Dispose()
        {
            _listener.Close();
            _loop.Wait(TimeSpan.FromSeconds(5));
        }
    }

    [Fact]
    public async Task A_conflict_on_the_first_page_is_asked_again_once_and_the_second_answer_is_the_listing()
    {
        using var server = new Scripted((409, Conflict), (200, Listing));
        using var client = new CloudClient(server.Origin, CloudClient.CreateHandler(), _cache);

        var page = await client.ListFolderAddressAsync("lib:Trip", null, 500, CancellationToken.None);

        Assert.Equal("c2", page!.NextCursor);
        Assert.Single(page.Images);
        Assert.Equal(2, server.Targets.Count);
        Assert.Equal(server.Targets[0], server.Targets[1]);
        Assert.DoesNotContain("cursor", server.Targets[0]);
    }

    [Fact]
    public async Task A_conflict_on_a_page_with_a_cursor_is_reported_without_asking_again()
    {
        using var server = new Scripted((409, Conflict), (200, Listing));
        using var client = new CloudClient(server.Origin, CloudClient.CreateHandler(), _cache);

        Assert.Null(await client.ListFolderAddressAsync("lib:Trip", "c1", 500, CancellationToken.None));
        Assert.Single(server.Targets);
        Assert.Contains("cursor=c1", server.Targets[0]);
    }

    [Fact]
    public async Task A_conflict_on_another_listing_route_is_not_asked_again()
    {
        using var server = new Scripted((409, Conflict), (200, "{\"dirs\":[],\"images\":[]}"));
        using var client = new CloudClient(server.Origin, CloudClient.CreateHandler(), _cache);

        Assert.Null(await client.ListDirAsync("/srv/lib", null, 500, CancellationToken.None));
        Assert.Single(server.Targets);
    }

    [Fact]
    public async Task A_second_conflict_is_the_failure_a_conflict_already_was_after_exactly_two_requests()
    {
        using var server = new Scripted((409, Conflict));
        using var client = new CloudClient(server.Origin, CloudClient.CreateHandler(), _cache);

        Assert.Null(await client.ListFolderAddressAsync("lib:Trip", null, 500, CancellationToken.None));
        Assert.Equal(2, server.Targets.Count);
    }

    [Theory]
    [InlineData(404)]
    [InlineData(500)]
    public async Task Other_failures_are_not_asked_again(int status)
    {
        using var server = new Scripted((status, "{\"error\":\"x\"}"), (200, Listing));
        using var client = new CloudClient(server.Origin, CloudClient.CreateHandler(), _cache);

        Assert.Null(await client.ListFolderAddressAsync("lib:Trip", null, 500, CancellationToken.None));
        Assert.Single(server.Targets);
    }
}

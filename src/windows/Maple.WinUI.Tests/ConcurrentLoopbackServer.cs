using System.Net;

namespace Maple.WinUI.Tests;

internal sealed class ConcurrentLoopbackServer : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly Func<HttpListenerContext, Task> _handle;
    private readonly Task _loop;
    private readonly List<(string Method, string Target)> _requests = new();
    private int _inFlight;
    private int _peak;

    public ConcurrentLoopbackServer(Func<HttpListenerContext, Task> handle)
    {
        _handle = handle;
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

    public int PeakInFlight => Volatile.Read(ref _peak);

    public IReadOnlyList<(string Method, string Target)> Requests { get { lock (_requests) return _requests.ToArray(); } }

    private async Task Serve()
    {
        while (_listener.IsListening)
        {
            HttpListenerContext context;
            try { context = await _listener.GetContextAsync(); }
            catch (Exception ex) when (ex is HttpListenerException or ObjectDisposedException) { return; }
            _ = Task.Run(() => Handle(context));
        }
    }

    private async Task Handle(HttpListenerContext context)
    {
        lock (_requests) _requests.Add((context.Request.HttpMethod, context.Request.Url!.PathAndQuery));
        var now = Interlocked.Increment(ref _inFlight);
        int seen;
        while (now > (seen = Volatile.Read(ref _peak)) && Interlocked.CompareExchange(ref _peak, now, seen) != seen) { }
        try { await _handle(context); }
        finally
        {
            Interlocked.Decrement(ref _inFlight);
            context.Response.Close();
        }
    }

    public void Dispose()
    {
        _listener.Close();
        _loop.Wait(TimeSpan.FromSeconds(5));
    }
}

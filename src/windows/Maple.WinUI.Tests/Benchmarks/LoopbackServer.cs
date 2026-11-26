using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Maple.WinUI.Tests;

internal sealed class LoopbackServer : IDisposable
{
    private readonly HttpListener _listener = new();

    internal LoopbackServer(Func<HttpListenerContext, Task> handle)
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        Url = $"http://localhost:{port}";
        _listener.Prefixes.Add(Url + "/");
        _listener.Start();
        _ = Task.Run(() => AcceptAsync(handle));
    }

    internal string Url { get; }

    internal static async Task WriteJsonAsync(HttpListenerContext context, string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        context.Response.ContentType = "application/json";
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes);
    }

    internal static async Task WriteBytesAsync(HttpListenerContext context, byte[] bytes)
    {
        context.Response.ContentType = "application/octet-stream";
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes);
    }

    internal static Task WriteLoginAsync(HttpListenerContext context) =>
        WriteJsonAsync(context, """{"access_token":"bench-token","refresh_token":"bench-refresh"}""");

    public void Dispose() => _listener.Close();

    private async Task AcceptAsync(Func<HttpListenerContext, Task> handle)
    {
        while (_listener.IsListening)
        {
            HttpListenerContext context;
            try { context = await _listener.GetContextAsync(); }
            catch (Exception error) when (error is HttpListenerException or ObjectDisposedException) { return; }
            _ = Task.Run(async () =>
            {
                try { await handle(context); }
                catch (Exception error) when (error is HttpListenerException or IOException or ObjectDisposedException) { }
                finally
                {
                    try { context.Response.Close(); }
                    catch (Exception error) when (error is HttpListenerException or ObjectDisposedException) { }
                }
            });
        }
    }
}

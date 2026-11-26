// Shared fake transports for the Maple Cloud client route tests: a recording
// handler that answers from a queue of canned responses, one that throws, and
// one that holds the headers back until the caller cancels.

using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Tests;

/// <summary>Records every request and answers from a queue of
/// canned responses (the last one repeats).</summary>
internal sealed class FakeHandler : HttpMessageHandler
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


internal sealed class ThrowingHandler(Exception error) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken) =>
        throw error;
}

/// <summary>Holds the response headers back until the caller cancels.</summary>
internal sealed class HangingHandler : HttpMessageHandler
{
    public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Started.SetResult();
        await Task.Delay(Timeout.Infinite, cancellationToken);
        throw new InvalidOperationException("unreachable");
    }
}

using System.Net;
using System.Text;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudSignInTransportTests : IDisposable
{
    private readonly string _cache = Path.Combine(Path.GetTempPath(), "maple-cloud-signin-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_cache)) Directory.Delete(_cache, true); }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(respond(request));
    }

    private static HttpResponseMessage Unreachable(HttpRequestMessage _) => throw new HttpRequestException("connection refused");

    private static HttpResponseMessage Json(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private CloudClient Client(Func<HttpRequestMessage, HttpResponseMessage> respond) =>
        new("https://maple.example.test", new Handler(respond), _cache);

    private static readonly CloudPkcePending Pending = new("https://maple.example.test", "verifier", "state-1");

    [Fact]
    public async Task RedeemReturnsFailureWhenServerUnreachable()
    {
        using var client = Client(Unreachable);
        var (ok, message, retryable) = await client.RedeemNativeCodeAsync("code", "verifier", CancellationToken.None);
        Assert.False(ok);
        Assert.True(retryable);
        Assert.Contains("could not reach", message);
    }

    [Fact]
    public async Task CallbackRedeemReturnsFailureOnTransportErrorAndSuccessOnTokens()
    {
        using var down = Client(Unreachable);
        Assert.False((await CloudSignInCallback.RedeemAsync(down, Pending, "code")).Ok);

        using var up = Client(_ => Json("""{"access_token":"a","refresh_token":"r","user":{"email":"x@y.z"}}"""));
        var (ok, _, _) = await CloudSignInCallback.RedeemAsync(up, Pending, "code");
        Assert.True(ok);
        Assert.Equal("r", up.RefreshToken);
    }

    [Fact]
    public async Task ProbeStillSucceedsWithoutDevLoginWhenBootstrapRequestDrops()
    {
        using var client = Client(request => request.RequestUri!.AbsolutePath.EndsWith("health")
            ? Json("""{"ok":true,"product":"maple","db_connected":true,"version":"1"}""")
            : Unreachable(request));
        var (ok, _, devLogin) = await client.ProbeAsync(CancellationToken.None);
        Assert.True(ok);
        Assert.False(devLogin);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest, false)]
    [InlineData(HttpStatusCode.Unauthorized, false)]
    [InlineData(HttpStatusCode.NotFound, false)]
    [InlineData(HttpStatusCode.TooManyRequests, true)]
    [InlineData(HttpStatusCode.InternalServerError, true)]
    [InlineData(HttpStatusCode.ServiceUnavailable, true)]
    public async Task RedeemRejectionIsRetryableOnlyForTransientStatuses(HttpStatusCode status, bool retryable)
    {
        using var client = Client(_ => new HttpResponseMessage(status));
        var (ok, _, actual) = await CloudSignInCallback.RedeemAsync(client, Pending, "code");
        Assert.False(ok);
        Assert.Equal(retryable, actual);
    }

    [Fact]
    public async Task ProbeReportsUnreachableServerWhenHealthRequestDrops()
    {
        using var client = Client(Unreachable);
        var (ok, message, _) = await client.ProbeAsync(CancellationToken.None);
        Assert.False(ok);
        Assert.Contains("unreachable", message);
    }

    [Fact]
    public async Task GetFoldersReturnsNullWhenServerUnreachable()
    {
        using var client = Client(Unreachable);
        Assert.Null(await client.GetFoldersAsync(CancellationToken.None));
    }

    [Theory]
    [InlineData("?code=abc&state=state-1", true)]
    [InlineData("?code=abc&state=other", false)]
    [InlineData("?state=state-1", false)]
    public void CallbackMustCarryCodeAndMatchingState(string query, bool expected) =>
        Assert.Equal(expected, CloudSignInCallback.MatchesPending(new Uri("maple-app://auth-success" + query), Pending, out _));
}

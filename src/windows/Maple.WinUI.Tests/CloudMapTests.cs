using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudMapTests
{
    [Fact]
    public async Task WrappedViewportUsesInvariantCoordinatesAndSharedSearchFilters()
    {
        using var fixture = new Fixture("""{"cells":[{"lat":5,"lng":179.5,"count":3,"representativeAssetId":"a","placeLabel":"Fiji"}]}""");
        var originalCulture = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-FR");
            var cells = await fixture.Client.GetMapClustersAsync(new(170.5, -20, -170.5, 20, 5),
                new() { MinimumRating = 4, People = "Ada", Places = "Fiji", Hidden = CloudHiddenFilter.Only }, CancellationToken.None);
            Assert.Equal("Fiji", Assert.Single(cells).PlaceLabel);
            Assert.Contains("bbox=170.5,-20,-170.5,20&zoom=5", Uri.UnescapeDataString(fixture.Handler.Query));
            Assert.Contains("rating=4", fixture.Handler.Query);
            Assert.Contains("people=Ada&place=Fiji", fixture.Handler.Query);
            Assert.Contains("hidden=only", fixture.Handler.Query);
        }
        finally { CultureInfo.CurrentCulture = originalCulture; }
    }

    [Theory]
    [InlineData(double.NaN, 0, 1, 1, 1)]
    [InlineData(0, 10, 1, 0, 1)]
    [InlineData(-181, 0, 1, 1, 1)]
    [InlineData(0, 0, 1, 91, 1)]
    [InlineData(0, 0, 1, 1, 21)]
    public void InvalidViewportFailsBeforeNetwork(double west, double south, double east, double north, int zoom) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new CloudMapViewport(west, south, east, north, zoom).ToQueryString());

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"cells\":[null]}")]
    [InlineData("{\"cells\":[{\"count\":1,\"representativeAssetId\":\"a\"}]}")]
    [InlineData("{\"cells\":[{\"lat\":91,\"lng\":0,\"count\":1,\"representativeAssetId\":\"a\"}]}")]
    public async Task InvalidClustersAreErrorsRatherThanEmptyMaps(string body)
    {
        using var fixture = new Fixture(body);
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Client.GetMapClustersAsync(new(-180, -90, 180, 90, 0), new(), CancellationToken.None));
    }

    [Fact]
    public async Task EmptyCellsAreAValidNoLocationResult()
    {
        using var fixture = new Fixture("{\"cells\":[]}");
        Assert.Empty(await fixture.Client.GetMapClustersAsync(new(-180, -90, 180, 90, 0), new(), CancellationToken.None));
    }

    [Fact]
    public async Task OversizedClusterPayloadIsRejected()
    {
        var cell = new { lat = 0, lng = 0, count = 1, representativeAssetId = "a" };
        using var fixture = new Fixture(System.Text.Json.JsonSerializer.Serialize(new { cells = Enumerable.Repeat(cell, 4357) }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Client.GetMapClustersAsync(new(-180, -90, 180, 90, 0), new(), CancellationToken.None));
    }

    [Fact]
    public async Task ViewportCancellationReachesThePendingRequest()
    {
        using var fixture = new Fixture("{\"cells\":[]}");
        fixture.Handler.Delay = true;
        using var owner = new CancellationTokenSource();
        var request = fixture.Client.GetMapClustersAsync(new(-180, -90, 180, 90, 0), new(), owner.Token);
        await fixture.Handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        owner.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
    }

    [Theory]
    [InlineData(404)]
    [InlineData(501)]
    public async Task OnlyUnsupportedConfigHidesTheCapability(int status)
    {
        using var fixture = new Fixture("{}", (HttpStatusCode)status);
        Assert.Null(await fixture.Client.GetMapConfigAsync(CancellationToken.None));
    }

    [Fact]
    public async Task ServerFailureRemainsRetryable()
    {
        using var fixture = new Fixture("{}", HttpStatusCode.ServiceUnavailable);
        var error = await Assert.ThrowsAsync<HttpRequestException>(() => fixture.Client.GetMapConfigAsync(CancellationToken.None));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, error.StatusCode);
    }

    [Theory]
    [InlineData("https://tiles.example/{z}/{x}/{y}.png")]
    [InlineData("https://tiles.example/style.json")]
    public async Task ConfigPreservesOperatorTemplateOrStyleUrl(string tileUrl)
    {
        using var fixture = new Fixture(System.Text.Json.JsonSerializer.Serialize(new { tile_url = tileUrl }));
        Assert.Equal(tileUrl, (await fixture.Client.GetMapConfigAsync(CancellationToken.None))!.TileUrl);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"tile_url\":\"file:///C:/secret\"}")]
    public async Task InvalidConfigCannotBecomeABlankMap(string body)
    {
        using var fixture = new Fixture(body);
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Client.GetMapConfigAsync(CancellationToken.None));
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string _cache = Path.Combine(Path.GetTempPath(), "maple-map-" + Guid.NewGuid().ToString("N"));
        public Handler Handler { get; }
        public CloudClient Client { get; }
        public Fixture(string body, HttpStatusCode status = HttpStatusCode.OK)
        {
            Handler = new Handler(body, status);
            Client = new CloudClient("https://maple.test", Handler, _cache);
        }
        public void Dispose() { Client.Dispose(); Directory.Delete(_cache, true); }
    }

    private sealed class Handler(string body, HttpStatusCode status) : HttpMessageHandler
    {
        public string Query = "";
        public bool Delay;
        public TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Query = request.RequestUri!.Query;
            Started.TrySetResult();
            if (Delay) await Task.Delay(Timeout.Infinite, cancellationToken);
            return new HttpResponseMessage(status) { Content = new StringContent(body) };
        }
    }
}

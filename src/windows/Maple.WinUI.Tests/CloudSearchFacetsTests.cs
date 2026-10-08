using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudSearchFacetsTests
{
    [Theory]
    [InlineData("{\"total\":0}", false)]
    [InlineData("{\"total\":0,\"people\":[],\"places\":[]}", true)]
    public async Task OmittedAndEmptyCapabilitiesStayDistinct(string body, bool supported)
    {
        await WithClient(HttpStatusCode.OK, body, async (client, handler) =>
        {
            var result = await client.GetSearchFacetsAsync(new() { MinimumRating = 4, Places = "Paris, France" }, CancellationToken.None);
            Assert.Equal(supported, result!.People != null);
            Assert.Equal(supported, result.Places != null);
            Assert.Contains("/api/search/facets?", handler.Route);
            Assert.Contains("rating=4", handler.Route);
            Assert.Contains("place=Paris%2C%20France", handler.Route);
            Assert.DoesNotContain("cursor=", handler.Route);
        });
    }

    [Theory]
    [InlineData("{\"total\":98635,\"scope\":{\"kind\":\"top\",\"limit\":2000,\"of\":98635}}", 2000L, 98635L)]
    [InlineData("{\"total\":3,\"scope\":{\"kind\":\"all\"}}", null, null)]
    [InlineData("{\"total\":3}", null, null)]
    [InlineData("{\"total\":3,\"scope\":{\"kind\":\"sampled\",\"limit\":10,\"of\":3}}", null, null)]
    [InlineData("{\"total\":3,\"scope\":\"top\"}", null, null)]
    [InlineData("{\"total\":3,\"scope\":{\"kind\":\"top\",\"limit\":\"many\",\"of\":3}}", null, null)]
    public async Task ScopeDecodesDefensively(string body, long? limit, long? of)
    {
        await WithClient(HttpStatusCode.OK, body, async (client, _) =>
        {
            var result = await client.GetSearchFacetsAsync(new(), CancellationToken.None);
            Assert.Equal(new CloudFacetScope(limit, of), result!.FacetScope);
            Assert.Equal(limit is not null, result.FacetScope.Note is not null);
        });
    }

    [Fact]
    public void TopScopeNoteUsesTheServersNumbers() =>
        Assert.Equal(
            string.Format(System.Globalization.CultureInfo.CurrentCulture, "Filters from the {0:N0} most relevant of {1:N0} results", 1000L, 8217L),
            new CloudFacetScope(1000, 8217).Note);

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.NotImplemented)]
    public async Task UnsupportedEndpointIsNotAnEmptyFacetSet(HttpStatusCode status) =>
        await WithClient(status, "", async (client, _) =>
            Assert.Null(await client.GetSearchFacetsAsync(new(), CancellationToken.None)));

    [Fact]
    public async Task ServerFailureIsNotReportedAsUnsupported() =>
        await WithClient(HttpStatusCode.ServiceUnavailable, "", async (client, _) =>
            await Assert.ThrowsAsync<HttpRequestException>(() => client.GetSearchFacetsAsync(new(), CancellationToken.None)));

    private static async Task WithClient(HttpStatusCode status, string body, Func<CloudClient, Handler, Task> test)
    {
        var cache = Path.Combine(Path.GetTempPath(), "maple-facets-" + Guid.NewGuid().ToString("N"));
        try
        {
            var handler = new Handler(status, body);
            using var client = new CloudClient("https://maple.test", handler, cache);
            await test(client, handler);
        }
        finally { Directory.Delete(cache, true); }
    }

    private sealed class Handler(HttpStatusCode status, string body) : HttpMessageHandler
    {
        public string Route = "";
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Route = request.RequestUri!.AbsoluteUri;
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) });
        }
    }
}

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

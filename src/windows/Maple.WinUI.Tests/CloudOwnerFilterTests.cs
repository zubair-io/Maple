using System.Net;
using System.Text;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

// #3817: Windows asset-owner filter — query serialization, owner facet and
// attribution decoding, picker choices and the signed-in user's id.
public sealed class CloudOwnerFilterTests
{
    private const string Ada = "664000000000000000000001";
    private const string Bea = "664000000000000000000002";
    private static readonly IReadOnlyDictionary<string, string> NoLabels = new Dictionary<string, string>();

    [Fact]
    public void OwnerFilterSerializesAsTheServerOwnerParameter()
    {
        Assert.Contains("owner=" + Ada, new CloudSearchQuery { OwnerId = Ada }.ToQueryString());
        Assert.DoesNotContain("owner=", new CloudSearchQuery().ToQueryString());
    }

    [Fact]
    public async Task FacetsDecodeOwnersIncludingEmailFreeAccounts()
    {
        var cache = Path.Combine(Path.GetTempPath(), "maple-owner-" + Guid.NewGuid().ToString("N"));
        var handler = new Handler($$"""{"total":3,"owners":[{"id":"{{Ada}}","email":"ada@example.com","count":2},{"id":"{{Bea}}","email":null,"count":1}]}""");
        try
        {
            using var client = new CloudClient("https://maple.test", handler, cache);
            var facets = await client.GetSearchFacetsAsync(new CloudSearchQuery { OwnerId = Bea }, CancellationToken.None);
            Assert.Contains("owner=" + Bea, handler.Route);
            Assert.Equal(2, facets!.Owners!.Length);
            Assert.Equal("ada@example.com", facets.Owners[0].Email);
            Assert.Equal(2, facets.Owners[0].Count);
            Assert.Null(facets.Owners[1].Email);
        }
        finally { Directory.Delete(cache, true); }
    }

    [Fact]
    public void ChoicesPutAllOwnersThenMyUploadsThenOtherOwners()
    {
        var owners = new[] { Facet(Bea, "bea@example.com", 4), Facet(Ada, "ada@example.com", 2) };
        var choices = CloudOwnerOptions.Build(owners, Ada.ToUpperInvariant(), "", NoLabels);
        Assert.Equal(new[]
        {
            new CloudOwnerOption("", "All owners"),
            new CloudOwnerOption(Ada, "Only my uploads (2)"),
            new CloudOwnerOption(Bea, "bea@example.com (4)"),
        }, choices);
    }

    [Fact]
    public void MyUploadsIsOfferedEvenWhenTheSignedInUserOwnsNothingInScope()
    {
        var choices = CloudOwnerOptions.Build(new[] { Facet(Bea, null, 1) }, Ada, "", NoLabels);
        Assert.Equal(new CloudOwnerOption(Ada, "Only my uploads"), choices[1]);
        Assert.Equal(new CloudOwnerOption(Bea, Bea + " (1)"), choices[2]);
    }

    [Fact]
    public void ServerWithoutOwnerFacetOffersNoOwnerChoice()
    {
        // An older server ignores owner=, so offering it would silently broaden results.
        Assert.Equal(new[] { new CloudOwnerOption("", "All owners") }, CloudOwnerOptions.Build(null, Ada, "", NoLabels));
    }

    [Fact]
    public void ZeroResultSelectionStaysVisibleWithItsKnownLabel()
    {
        var labels = new Dictionary<string, string> { [Bea] = "bea@example.com" };
        var choices = CloudOwnerOptions.Build(Array.Empty<CloudOwnerFacet>(), null, Bea, labels);
        Assert.Equal(new CloudOwnerOption(Bea, "bea@example.com"), choices[^1]);
        Assert.Equal(new CloudOwnerOption(Ada, "Only my uploads"),
            CloudOwnerOptions.Build(null, Ada, Ada, NoLabels)[^1]);
        Assert.Equal(new CloudOwnerOption(Bea, Bea), CloudOwnerOptions.Build(null, null, Bea, NoLabels)[^1]);
    }

    [Fact]
    public void CurrentUserIdIsTheAccessTokenSubject()
    {
        Assert.Equal(Ada, CloudClient.AccessTokenSubject(Jwt($$"""{"sub":"{{Ada}}","role":"member"}""")));
        Assert.Null(CloudClient.AccessTokenSubject(Jwt("""{"role":"member"}""")));
        Assert.Null(CloudClient.AccessTokenSubject(Jwt("""["not-an-object"]""")));
        Assert.Null(CloudClient.AccessTokenSubject("header.%%%.signature"));
        Assert.Null(CloudClient.AccessTokenSubject("not-a-jwt"));
        Assert.Null(CloudClient.AccessTokenSubject(null));
    }

    [Fact]
    public void InspectorShowsOwnerAttribution()
    {
        var withEmail = System.Text.Json.JsonSerializer.Deserialize<CloudInspectorMetadata>(
            $$$"""{"owner":{"id":"{{{Ada}}}","email":"ada@example.com"}}""")!;
        Assert.Contains(("Owner", "ada@example.com"), withEmail.Rows());
        var emailFree = System.Text.Json.JsonSerializer.Deserialize<CloudInspectorMetadata>(
            $$$"""{"owner":{"id":"{{{Bea}}}","email":null}}""")!;
        Assert.Contains(("Owner", Bea), emailFree.Rows());
        var unowned = System.Text.Json.JsonSerializer.Deserialize<CloudInspectorMetadata>("""{"owner":null}""")!;
        Assert.DoesNotContain(unowned.Rows(), row => row.Label == "Owner");
    }

    private static CloudOwnerFacet Facet(string id, string? email, long count) => new() { Id = id, Email = email, Count = count };

    // Unsigned test token: the client only reads its own claims; the server verifies.
    private static string Jwt(string payload)
    {
        static string Encode(string json) => Convert.ToBase64String(Encoding.UTF8.GetBytes(json))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return Encode("""{"alg":"HS256"}""") + "." + Encode(payload) + ".signature";
    }

    private sealed class Handler(string body) : HttpMessageHandler
    {
        public string Route = "";
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Route = request.RequestUri!.Query;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
        }
    }
}

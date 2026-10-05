using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudSearchQueryTests
{
    [Fact]
    public void FiltersUseServerVocabularyAndEscapeSeparators()
    {
        var query = new CloudSearchQuery
        {
            Filename = "IMG & snow", Text = "Kyoto 日本", MinimumRating = 4, Flag = "pick", Color = "red",
            People = "Ada,Grace", Places = "Portland, OR|Kyoto, Japan", Hidden = CloudHiddenFilter.Only,
            ExcludeHiddenPeople = true, Extension = "dng", Scope = CloudSearchScope.Places,
            Owner = "user123",
            From = new DateTimeOffset(2024, 1, 1, 0, 0, 0, TimeSpan.FromHours(-5)),
        }.ToQueryString();
        Assert.Contains("q=IMG%20%26%20snow", query);
        Assert.Contains("placeQuery=Kyoto%20%E6%97%A5%E6%9C%AC", query);
        Assert.Contains("rating=4&flag=pick&color=red&ext=dng", query);
        Assert.Contains("people=Ada%2CGrace&place=Portland%2C%20OR%7CKyoto%2C%20Japan", query);
        Assert.Contains("owner=user123", query);
        Assert.Contains("from=2024-01-01T05%3A00%3A00.000Z", query);
        Assert.Contains("scope=places&hidden=only&excludeHiddenPeople=true", query);
    }

    [Fact]
    public void OwnerQueryStringSerializesWhenPresentAndOmitsWhenNullOrEmpty()
    {
        Assert.Contains("owner=user123", new CloudSearchQuery { Owner = "user123" }.ToQueryString());
        Assert.Contains("owner=user%20456", new CloudSearchQuery { Owner = "user 456" }.ToQueryString());
        Assert.DoesNotContain("owner=", new CloudSearchQuery { Owner = null }.ToQueryString());
        Assert.DoesNotContain("owner=", new CloudSearchQuery { Owner = "" }.ToQueryString());
        Assert.DoesNotContain("owner=", new CloudSearchQuery { Owner = "   " }.ToQueryString());
        Assert.DoesNotContain("owner=", new CloudSearchQuery().ToQueryString());
    }

    [Fact]
    public void FacetsDeserializesOwnersBucket()
    {
        const string json = """
        {
            "total": 42,
            "owners": [
                { "id": "user123", "email": "user123@example.com", "count": 10 },
                { "id": "user456", "email": null, "count": 5 },
                { "value": "user789", "count": 2 }
            ]
        }
        """;
        var facets = System.Text.Json.JsonSerializer.Deserialize<CloudSearchFacets>(json);
        Assert.NotNull(facets);
        Assert.Equal(42, facets.Total);
        Assert.NotNull(facets.Owners);
        Assert.Equal(3, facets.Owners.Length);
        Assert.Equal("user123", facets.Owners[0].Id);
        Assert.Equal("user123", facets.Owners[0].Value);
        Assert.Equal("user123@example.com", facets.Owners[0].Email);
        Assert.Equal(10, facets.Owners[0].Count);
        Assert.Equal("user456", facets.Owners[1].Id);
        Assert.Equal("user456", facets.Owners[1].Value);
        Assert.Null(facets.Owners[1].Email);
        Assert.Equal(5, facets.Owners[1].Count);
        Assert.Equal("user789", facets.Owners[2].Value);
        Assert.Equal(2, facets.Owners[2].Count);
    }

    [Fact]
    public void InvalidValuesFailRatherThanSilentlyBroadeningResults()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new CloudSearchQuery { MinimumRating = 6 }.ToQueryString());
        Assert.Throws<ArgumentException>(() => new CloudSearchQuery { Flag = "all" }.ToQueryString());
        Assert.Throws<ArgumentOutOfRangeException>(() => new CloudSearchQuery { Sort = (CloudSearchSort)99 }.ToQueryString());
        Assert.Throws<ArgumentException>(() => new CloudSearchQuery { From = DateTimeOffset.MaxValue, Through = DateTimeOffset.MinValue }.ToQueryString());
    }

    [Theory]
    [InlineData(null, 2, "page=2", "cursor=")]
    [InlineData("opaque+/=", 0, "cursor=opaque%2B%2F%3D", "page=")]
    public async Task TransportPreservesServerPagingMode(string? cursor, int page, string expected, string absent)
    {
        var cache = Path.Combine(Path.GetTempPath(), "maple-search-" + Guid.NewGuid().ToString("N"));
        var handler = new Handler();
        try
        {
            using var client = new CloudClient("https://maple.test", handler, cache);
            var result = await client.SearchAsync(new CloudSearchQuery { MinimumRating = 3 }, page, cursor, CancellationToken.None);
            Assert.Contains(expected, handler.Route);
            Assert.DoesNotContain(absent, handler.Route);
            Assert.Contains("rating=3", handler.Route);
            Assert.False(result.CursorPaging);
            Assert.Equal(550, result.Total);
            Assert.Equal(2, result.Page);
            Assert.Equal(200, result.Limit);
        }
        finally { Directory.Delete(cache, true); }
    }

    [Fact]
    public async Task FailurePreservesStatusForAuthOfflineAndRetryUi()
    {
        var cache = Path.Combine(Path.GetTempPath(), "maple-search-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var client = new CloudClient("https://maple.test", new Handler { Status = HttpStatusCode.ServiceUnavailable }, cache);
            var failure = await Assert.ThrowsAsync<HttpRequestException>(() => client.SearchAsync(new(), 0, null, CancellationToken.None));
            Assert.Equal(HttpStatusCode.ServiceUnavailable, failure.StatusCode);
        }
        finally { Directory.Delete(cache, true); }
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"cursorPaging\":false,\"page\":0,\"limit\":200,\"total\":0}")]
    [InlineData("{\"results\":[],\"cursorPaging\":false,\"limit\":200,\"total\":0}")]
    [InlineData("{\"results\":[],\"cursorPaging\":false,\"page\":0,\"limit\":200}")]
    [InlineData("{\"results\":[],\"page\":0,\"limit\":200,\"total\":0}")]
    [InlineData("{\"results\":null,\"cursorPaging\":true,\"page\":0,\"limit\":200,\"total\":0}")]
    [InlineData("{\"results\":[],\"cursorPaging\":false,\"page\":0,\"limit\":0,\"total\":0}")]
    public async Task MalformedPagingCannotMasqueradeAsAnEmptyResult(string body)
    {
        var cache = Path.Combine(Path.GetTempPath(), "maple-search-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var client = new CloudClient("https://maple.test", new Handler { Body = body }, cache);
            await Assert.ThrowsAsync<InvalidOperationException>(() => client.SearchAsync(new(), 0, null, CancellationToken.None));
        }
        finally { Directory.Delete(cache, true); }
    }

    private sealed class Handler : HttpMessageHandler
    {
        public string Route = "";
        public HttpStatusCode Status = HttpStatusCode.OK;
        public string Body = """{"results":[],"cursorPaging":false,"nextCursor":null,"total":550,"page":2,"limit":200}""";
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Route = request.RequestUri!.Query;
            return Task.FromResult(new HttpResponseMessage(Status)
            {
                Content = new StringContent(Body),
            });
        }
    }
}

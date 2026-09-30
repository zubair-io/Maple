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
            From = new DateTimeOffset(2024, 1, 1, 0, 0, 0, TimeSpan.FromHours(-5)),
        }.ToQueryString();
        Assert.Contains("q=IMG%20%26%20snow", query);
        Assert.Contains("placeQuery=Kyoto%20%E6%97%A5%E6%9C%AC", query);
        Assert.Contains("rating=4&flag=pick&color=red&ext=dng", query);
        Assert.Contains("people=Ada%2CGrace&place=Portland%2C%20OR%7CKyoto%2C%20Japan", query);
        Assert.Contains("from=2024-01-01T05%3A00%3A00.000Z", query);
        Assert.Contains("scope=places&hidden=only&excludeHiddenPeople=true", query);
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

    private sealed class Handler : HttpMessageHandler
    {
        public string Route = "";
        public HttpStatusCode Status = HttpStatusCode.OK;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Route = request.RequestUri!.Query;
            return Task.FromResult(new HttpResponseMessage(Status)
            {
                Content = new StringContent("""{"results":[],"cursorPaging":false,"nextCursor":null,"total":550,"page":2,"limit":200}"""),
            });
        }
    }
}

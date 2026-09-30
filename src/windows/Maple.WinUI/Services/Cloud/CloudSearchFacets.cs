using System;
using System.Net;
using System.Net.Http;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud;

// Null means the server omitted that capability; an empty array means
// supported with no matches. Additional flags cover non-bucket filters.
public sealed class CloudSearchFacets
{
    [JsonPropertyName("total")] public long Total { get; set; }
    [JsonPropertyName("people")] public CloudSearchBucket[]? People { get; set; }
    [JsonPropertyName("places")] public CloudSearchBucket[]? Places { get; set; }
    [JsonPropertyName("extensions")] public CloudSearchBucket[]? Extensions { get; set; }
    [JsonPropertyName("supportedFilters")] public string[]? SupportedFilters { get; set; }
}

public sealed class CloudSearchBucket
{
    [JsonPropertyName("value")] public string Value { get; set; } = "";
    [JsonPropertyName("count")] public long Count { get; set; }
}

public sealed partial class CloudClient
{
    public async Task<CloudSearchFacets?> GetSearchFacetsAsync(CloudSearchQuery query, CancellationToken ct)
    {
        var route = "api/search/facets?" + query.ToQueryString();
        using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Get, route), ct);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.NotImplemented) return null;
        response.EnsureSuccessStatusCode();
        return await ReadJsonAsync<CloudSearchFacets>(response, ct)
            ?? throw new InvalidOperationException("Invalid search facets response");
    }
}

using System;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Text.Json;
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
    [JsonPropertyName("owners")] public CloudSearchBucket[]? Owners { get; set; }
    [JsonPropertyName("supportedFilters")] public string[]? SupportedFilters { get; set; }

    // Kept raw so a malformed scope can't fail the whole facets response.
    [JsonPropertyName("scope")] public JsonElement? Scope { get; set; }

    /// <summary>Which matches the buckets count (#4431); absent, unknown or
    /// malformed reads as every match.</summary>
    [JsonIgnore] public CloudFacetScope FacetScope => CloudFacetScope.From(Scope);
}

/// <summary>A broad text search's facets count only its <see cref="Limit"/>
/// most relevant results of <see cref="Of"/> matches (#4431); otherwise every
/// match, and both are null.</summary>
public sealed record CloudFacetScope(long? Limit, long? Of)
{
    public static readonly CloudFacetScope All = new(null, null);

    public bool IsTop => Limit is not null && Of is not null;

    /// <summary>The line shown above the facet pickers when the counts are cut.</summary>
    public string? Note => IsTop
        ? string.Format(CultureInfo.CurrentCulture, "Filters from the {0:N0} most relevant of {1:N0} results", Limit, Of)
        : null;

    public static CloudFacetScope From(JsonElement? scope)
    {
        if (scope is not { ValueKind: JsonValueKind.Object } element) return All;
        if (!element.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String
            || kind.GetString() != "top") return All;
        return Count(element, "limit") is { } cut && Count(element, "of") is { } total
            ? new CloudFacetScope(cut, total)
            : All;
    }

    // TryGetInt64 throws on a non-number, so the kind is checked first.
    private static long? Count(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt64(out var count)
            ? count
            : null;
}

public class CloudSearchBucket
{
    private string _value = "";
    [JsonPropertyName("value")]
    public string Value
    {
        get => string.IsNullOrEmpty(_value) ? (Id ?? "") : _value;
        set => _value = value;
    }

    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("email")] public string? Email { get; set; }
    [JsonPropertyName("count")] public long Count { get; set; }
}

/// <summary>Asset owner bucket (#3817). Email-free accounts are valid users,
/// so <see cref="Email"/> may be null.</summary>
public sealed class CloudOwnerFacet : CloudSearchBucket
{
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

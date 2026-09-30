using System;
using System.Collections.Generic;
using System.Globalization;

namespace Maple.WinUI.Services.Cloud;

public enum CloudSearchSort { CapturedDescending, CapturedAscending, Name, Rating }
public enum CloudSearchScope { Photos, Places, People }
public enum CloudHiddenFilter { None, Only, All }

/// <summary>Shared search/facet/map filter contract from the server's
/// routes/search/query-schema.ts, used by timeline search and its facets.</summary>
public sealed record CloudSearchQuery
{
    public string? Filename { get; init; }
    public string? Text { get; init; }
    public int? MinimumRating { get; init; }
    public string? Flag { get; init; }
    public string? Color { get; init; }
    public string? Extension { get; init; }
    public string? People { get; init; }
    public string? Places { get; init; }
    public string? LibraryId { get; init; }
    public string? PathPrefix { get; init; }
    public DateTimeOffset? From { get; init; }
    public DateTimeOffset? Through { get; init; }
    public CloudSearchSort Sort { get; init; } = CloudSearchSort.CapturedDescending;
    public CloudSearchScope Scope { get; init; }
    public CloudHiddenFilter Hidden { get; init; }
    public bool ExcludeHiddenPeople { get; init; }

    public string ToQueryString()
    {
        if (MinimumRating is < 0 or > 5) throw new ArgumentOutOfRangeException(nameof(MinimumRating));
        if (Flag is not (null or "pick" or "none" or "reject")) throw new ArgumentException("Invalid flag", nameof(Flag));
        if (From > Through) throw new ArgumentException("Search date range is reversed");
        var parts = new List<string>();
        void Add(string key, string? value)
        {
            if (!string.IsNullOrWhiteSpace(value)) parts.Add(key + "=" + Uri.EscapeDataString(value));
        }
        Add("q", Filename); Add("placeQuery", Text);
        Add("rating", MinimumRating?.ToString(CultureInfo.InvariantCulture));
        Add("flag", Flag); Add("color", Color); Add("ext", Extension);
        Add("people", People); Add("place", Places);
        Add("libraryId", LibraryId); Add("pathPrefix", PathPrefix);
        Add("from", From?.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
        Add("to", Through?.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
        Add("sort", Sort switch
        {
            CloudSearchSort.CapturedDescending => "captured_desc", CloudSearchSort.CapturedAscending => "captured_asc",
            CloudSearchSort.Name => "name", CloudSearchSort.Rating => "rating", _ => throw new ArgumentOutOfRangeException(nameof(Sort)),
        });
        Add("scope", Scope switch
        {
            CloudSearchScope.Photos => "photos", CloudSearchScope.Places => "places", CloudSearchScope.People => "people",
            _ => throw new ArgumentOutOfRangeException(nameof(Scope)),
        });
        Add("hidden", Hidden switch
        {
            CloudHiddenFilter.None => "none", CloudHiddenFilter.Only => "only", CloudHiddenFilter.All => "all",
            _ => throw new ArgumentOutOfRangeException(nameof(Hidden)),
        });
        if (ExcludeHiddenPeople) Add("excludeHiddenPeople", "true");
        return string.Join("&", parts);
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace Maple.WinUI.Services.Cloud;

public sealed record CloudOwnerOption(string Id, string Label);

/// <summary>Asset-owner picker choices (#3817), matching the Web
/// <c>timelineOwnerOptions</c> and Apple <c>AssetOwnerFilterModel</c>:
/// "All owners", then "Only my uploads" for the signed-in user, then the
/// other owners from the facet, each with its asset count.</summary>
public static class CloudOwnerOptions
{
    public const string AllOwners = "All owners";
    public const string MyUploads = "Only my uploads";

    /// <param name="owners">The server's owner facet, computed without the
    /// owner filter so choosing one never hides the others. Null means the
    /// server has no owner facet; then no owner choice is offered, since an
    /// older server would ignore <c>owner=</c> and silently broaden results.</param>
    /// <param name="knownLabels">Labels from earlier facets, so a selected
    /// owner that now has zero results keeps its email rather than an id.</param>
    public static IReadOnlyList<CloudOwnerOption> Build(IReadOnlyList<CloudSearchBucket>? owners,
        string? currentUserId, string selectedId, IReadOnlyDictionary<string, string> knownLabels)
    {
        var choices = new List<CloudOwnerOption> { new("", AllOwners) };
        if (owners != null)
        {
            var me = string.IsNullOrEmpty(currentUserId) ? null : currentUserId;
            if (me != null)
            {
                var mine = owners.FirstOrDefault(owner => SameId(owner.Id ?? owner.Value, me));
                choices.Add(new(mine?.Id ?? mine?.Value ?? me, mine == null ? MyUploads : $"{MyUploads} ({mine.Count})"));
            }
            foreach (var owner in owners.Where(owner => me == null || !SameId(owner.Id ?? owner.Value, me)))
            {
                var id = owner.Id ?? owner.Value;
                choices.Add(new(id, $"{Label(id, owner.Email)} ({owner.Count})"));
            }
        }
        // A zero-result filter or an unavailable facet must not silently
        // clear the selected owner.
        if (selectedId.Length > 0 && !choices.Any(choice => SameId(choice.Id, selectedId)))
            choices.Add(new(selectedId, SameId(selectedId, currentUserId ?? "") ? MyUploads
                : knownLabels.TryGetValue(selectedId, out var known) ? known : selectedId));
        return choices;
    }

    /// <summary>Display label for an owner: its email, or its id for an
    /// email-free account.</summary>
    public static string Label(string id, string? email) =>
        string.IsNullOrWhiteSpace(email) ? id : email.Trim();

    public static bool SameId(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
}

public sealed partial class CloudClient
{
    /// <summary>The signed-in user's id (the access token's <c>sub</c>), or
    /// null when signed out — used to offer "Only my uploads".</summary>
    public string? CurrentUserId => AccessTokenSubject(_accessToken);

    /// <summary>Read the <c>sub</c> claim from a JWT's payload. The server
    /// verifies the signature; the client only needs its own id for display
    /// and filtering, so a malformed token simply yields null.</summary>
    public static string? AccessTokenSubject(string? token)
    {
        var parts = token?.Split('.');
        if (parts is not { Length: 3 }) return null;
        var payload = parts[1].Replace('-', '+').Replace('_', '/');
        payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
        try
        {
            using var claims = JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(payload)));
            return claims.RootElement.ValueKind == JsonValueKind.Object
                && claims.RootElement.TryGetProperty("sub", out var sub)
                && sub.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(sub.GetString())
                ? sub.GetString() : null;
        }
        catch (Exception error) when (error is FormatException or JsonException) { return null; }
    }
}

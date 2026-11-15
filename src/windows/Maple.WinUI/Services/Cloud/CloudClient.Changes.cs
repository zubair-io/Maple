using System;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.CloudFiles;

namespace Maple.WinUI.Services.Cloud;

public sealed partial class CloudClient
{
    internal async Task<CloudChangePage?> ListChangesAsync(long since, int limit, CancellationToken ct)
    {
        var route = $"api/changes?since={since}&limit={limit}";
        using var response = await GetResponseAsync(route, ct, authenticated: true, reportTransportFailureAsNull: false);
        if (response == null) return null;
        if (response.StatusCode == HttpStatusCode.Conflict)
        {
            try
            {
                using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
                if (body.RootElement.TryGetProperty("current", out var current) && current.TryGetInt64(out var cursor))
                    throw new CloudChangeCursorExpiredException(Math.Max(0, cursor));
            }
            catch (JsonException) { }
            throw new HttpRequestException("Change feed returned 409 without a valid current cursor.");
        }
        if (!response.IsSuccessStatusCode)
        {
            DiagLog.Write($"[cloud] GET {route} → {(int)response.StatusCode}");
            return null;
        }
        return await ReadJsonAsync<CloudChangePage>(response, ct);
    }
}

internal sealed class CloudChangeCursorExpiredException : Exception
{
    public long Current { get; }
    public CloudChangeCursorExpiredException(long current) : base("The Cloud change cursor expired.") => Current = current;
}

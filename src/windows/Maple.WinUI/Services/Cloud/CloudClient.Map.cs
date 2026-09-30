using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud;

public sealed partial class CloudClient
{
    public async Task<CloudMapConfig?> GetMapConfigAsync(CancellationToken ct)
    {
        using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Get, "api/map/config"), ct);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.NotImplemented) return null;
        response.EnsureSuccessStatusCode();
        var config = await ReadJsonAsync<CloudMapConfig>(response, ct);
        if (config == null || !Uri.TryCreate(config.TileUrl, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
            throw new InvalidOperationException("The server returned an invalid map tile configuration.");
        return config;
    }

    public async Task<CloudMapCell[]> GetMapClustersAsync(CloudMapViewport viewport, CloudSearchQuery query, CancellationToken ct)
    {
        var route = "api/map/clusters?" + viewport.ToQueryString() + "&" + query.ToQueryString();
        using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Get, route), ct);
        response.EnsureSuccessStatusCode();
        var result = await ReadJsonAsync<CloudMapClusters>(response, ct);
        // A 64-cell span can straddle 65 buckets per axis, plus longitude wrap.
        if (result?.Cells == null || result.Cells.Length > 4356 || result.Cells.Any(cell => cell == null || !cell.IsValid))
            throw new InvalidOperationException("The server returned invalid map clusters.");
        return result.Cells;
    }
}

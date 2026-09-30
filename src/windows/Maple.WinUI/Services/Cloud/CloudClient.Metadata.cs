using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud;

public sealed partial class CloudClient
{
    /// <summary>Metadata editing must distinguish an absent sidecar from an
    /// authentication, permission or network failure before showing a preview.</summary>
    public async Task<string?> ReadMetadataXmpAsync(string serverPath, CancellationToken cancellation)
    {
        using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Get,
            $"api/xmp?path={Uri.EscapeDataString(serverPath)}"), cancellation);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(cancellation);
    }

    /// <summary>The batch endpoint can return HTTP 207 with a failed item.
    /// Success requires a matching per-address acknowledgement, not just 2xx.</summary>
    public async Task WriteMetadataAsync(string address, IReadOnlyDictionary<string, object?> metadata,
        CancellationToken cancellation)
    {
        var payload = new { entries = new[] { new { address, metadata } } };
        using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Post, "api/xmp/batch")
        {
            Content = JsonContent(payload),
        }, cancellation);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
        if (!json.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("Server did not acknowledge the metadata write.");
        foreach (var result in results.EnumerateArray())
        {
            if (!result.TryGetProperty("address", out var target) || target.GetString() != address) continue;
            if (result.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True) return;
            var message = result.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String
                ? error.GetString() : "Server rejected the metadata write.";
            throw new InvalidOperationException(message);
        }
        throw new InvalidOperationException("Server did not acknowledge this photo's metadata write.");
    }
}

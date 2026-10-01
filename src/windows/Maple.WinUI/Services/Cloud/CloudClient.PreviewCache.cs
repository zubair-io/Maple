using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud;

public sealed partial class CloudClient
{
    private sealed record PreviewCacheEntry(string? ETag, string ContentHash);

    // Both tiers are mutable server derivatives. Revalidate their ETag and
    // expose changed bytes under a new URI so XAML cannot retain old pixels.
    private async Task<string?> FetchCachedImageAsync(string kind, string key, string route, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{ServerUrl}|{key}")))[..32];
        var index = Path.Combine(_cacheDir, identity + $"-{kind}.json");
        PreviewCacheEntry? entry = null;
        try
        {
            if (File.Exists(index)) entry = JsonSerializer.Deserialize<PreviewCacheEntry>(await File.ReadAllTextAsync(index, ct));
        }
        catch (Exception error) when (error is IOException or JsonException) { }
        // Cache metadata cannot supply arbitrary paths, even if damaged.
        if (entry?.ContentHash is not { Length: 64 } hash || !hash.All(Uri.IsHexDigit)) entry = null;
        string ContentPath(string contentHash) => Path.Combine(_cacheDir, $"{identity}-{contentHash}-{kind}.avif");
        var existing = entry == null ? null : ContentPath(entry.ContentHash);
        if (existing != null && !File.Exists(existing)) { existing = null; entry = null; }
        EntityTagHeaderValue? validator = null;
        if (entry != null) EntityTagHeaderValue.TryParse(entry.ETag, out validator);

        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var response = await SendAsync(() =>
            {
                var request = new HttpRequestMessage(HttpMethod.Get, route);
                if (validator != null) request.Headers.IfNoneMatch.Add(validator);
                return request;
            }, ct);
            if (response.StatusCode == HttpStatusCode.NotModified)
            {
                if (existing != null && File.Exists(existing)) return existing;
                validator = null;
                continue;
            }
            if (response.StatusCode == HttpStatusCode.Accepted)
            {
                await Task.Delay(TimeSpan.FromSeconds(2), ct);
                continue;
            }
            if (!response.IsSuccessStatusCode) return null;
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            var contentHash = Convert.ToHexString(SHA256.HashData(bytes));
            var path = ContentPath(contentHash);
            if (!File.Exists(path)) await WritePreviewCacheFileAsync(path, bytes, ct);
            var metadata = JsonSerializer.SerializeToUtf8Bytes(new PreviewCacheEntry(response.Headers.ETag?.ToString(), contentHash));
            await WritePreviewCacheFileAsync(index, metadata, ct);
            return path;
        }
        return null;
    }

    private static async Task WritePreviewCacheFileAsync(string path, byte[] bytes, CancellationToken ct)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllBytesAsync(temporary, bytes, ct);
            ct.ThrowIfCancellationRequested();
            File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}

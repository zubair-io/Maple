using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>Library browsing (folders + one directory level at a time,
    /// the same routes every other platform's cloud source walks) and
    /// thumb/preview fetch into the local AVIF disk cache.</summary>
    public sealed partial class CloudClient
    {
        // --- Library browsing ---

        public Task<CloudFolder[]?> GetFoldersAsync(CancellationToken ct) =>
            GetJsonAsync<CloudFolder[]>("api/folders", ct);

        /// <summary>One directory level (GET /api/fs/dir) — the same endpoint
        /// the Apple cloud source browses with, so Windows sees exactly the
        /// tree Finder does. Pass the previous page's NextCursor to continue a
        /// large directory; omitting both cursor and limit asks for the whole
        /// listing in one shot (the server's historical default).</summary>
        public async Task<CloudDirListing?> ListDirAsync(
            string absPath, string? cursor, int limit, CancellationToken ct)
        {
            var query = $"api/fs/dir?path={Uri.EscapeDataString(absPath)}&limit={limit}";
            if (!string.IsNullOrEmpty(cursor))
                query += $"&cursor={Uri.EscapeDataString(cursor)}";
            try
            {
                return await GetJsonAsync<CloudDirListing>(query, ct);
            }
            catch (Exception ex) when (
                ex is HttpRequestException
                || (ex is TaskCanceledException && !ct.IsCancellationRequested))
            {
                // Browsing runs from `async void` UI handlers, where an escaped
                // transport exception takes the process down. A dropped link
                // or a hung server is an ordinary thing for a network browser
                // to meet, so it joins the failure the callers already handle:
                // null, logged, surfaced in the status line.
                DiagLog.Write($"[cloud] dir unreachable for {absPath}: {ex.Message}");
                return null;
            }
        }

        // --- Images (AVIF, disk-cached) ---

        /// <summary>Fetch a thumb (512px) or preview (1280px) AVIF into the
        /// local cache and return its path. 202 means still indexing — retried
        /// once after the advertised delay; null on failure.</summary>
        public Task<string?> FetchImageAsync(
            string kind, string address, CancellationToken ct) =>
            FetchCachedImageAsync(
                kind, $"{kind}|{address}", $"api/{kind}/{EncodeAddress(address)}", ct);

        /// <summary>The path-addressed variant (GET /api/fs/thumb,
        /// /api/fs/preview) used by the folder browser, matching the Apple
        /// cloud source. The `/api/{kind}/{address}` form above needs an
        /// indexed asset with a registered slug; the filesystem walk hands us
        /// absolute paths and has to render files the indexer hasn't reached
        /// yet, so the browse grid addresses images the way it listed
        /// them.</summary>
        public Task<string?> FetchFsImageAsync(
            string kind, string absPath, CancellationToken ct) =>
            FetchCachedImageAsync(
                kind, $"fs|{kind}|{absPath}",
                $"api/fs/{kind}?path={Uri.EscapeDataString(absPath)}", ct);

        private async Task<string?> FetchCachedImageAsync(
            string kind, string cacheKey, string route, CancellationToken ct)
        {
            var hash = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes($"{ServerUrl}|{cacheKey}")))[..32];
            var cachePath = Path.Combine(_cacheDir, $"{hash}-{kind}.avif");
            if (File.Exists(cachePath))
                return cachePath;

            for (var attempt = 0; attempt < 2; attempt++)
            {
                using var response = await SendAsync(
                    () => new HttpRequestMessage(HttpMethod.Get, route), ct);
                if (response.StatusCode == HttpStatusCode.Accepted)
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), ct);
                    continue;
                }
                if (!response.IsSuccessStatusCode)
                    return null;
                var bytes = await response.Content.ReadAsByteArrayAsync(ct);
                var tempPath = cachePath + ".tmp";
                await File.WriteAllBytesAsync(tempPath, bytes, ct);
                File.Move(tempPath, cachePath, overwrite: true);
                return cachePath;
            }
            return null;
        }

        /// <summary>slug:relPath → enc(slug)/enc(seg1)/enc(seg2)… — the server
        /// decodes each segment individually.</summary>
        private static string EncodeAddress(string address)
        {
            var colon = address.IndexOf(':');
            var slug = colon < 0 ? address : address[..colon];
            var relPath = colon < 0 ? string.Empty : address[(colon + 1)..];
            var segments = relPath
                .Split('/', StringSplitOptions.RemoveEmptyEntries)
                .Select(Uri.EscapeDataString);
            return string.Join("/", new[] { Uri.EscapeDataString(slug) }.Concat(segments));
        }
    }
}

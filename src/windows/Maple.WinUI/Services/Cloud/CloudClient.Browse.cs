using System;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>Library browsing (folders + one directory level at a time,
    /// the same routes the Apple cloud source walks) and address-keyed
    /// thumb/preview fetch into the local AVIF disk cache.</summary>
    public sealed partial class CloudClient
    {
        // --- Library browsing ---

        public Task<CloudFolder[]?> GetFoldersAsync(CancellationToken ct) =>
            GetJsonAsync<CloudFolder[]>("api/folders", ct);

        /// <summary>One directory level for the in-app browser (GET
        /// /api/fs/dir). Pass the previous page's NextCursor to continue a
        /// large directory; omitting both cursor and limit asks for the whole
        /// listing in one shot (the server's historical default).
        ///
        /// Still path-addressed: the absolute path it returns keys the other
        /// routes the browser speaks (`/api/xmp?path=`, `/api/preview?path=`,
        /// `/api/assets/by-fspath`). The File Explorer sync root reads the
        /// unified listing instead (<see cref="ListFolderAsync"/>).</summary>
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

        /// <summary>One page of the unified folder listing, GET
        /// /api/folder/:slug/* — the route the Apple File Provider
        /// enumerates (#4006). `slug:` with an empty relPath is the library
        /// root. Null on a transport failure or a non-success status.</summary>
        public Task<CloudFolderListing?> ListFolderAsync(
            string address, string? cursor, int limit, CancellationToken ct)
        {
            var query = $"api/folder/{EncodeAddress(address)}?limit={limit}";
            if (!string.IsNullOrEmpty(cursor))
                query += $"&cursor={Uri.EscapeDataString(cursor)}";
            return GetJsonAsync<CloudFolderListing>(query, ct);
        }

        // --- Images (AVIF, disk-cached) ---

        /// <summary>Fetch a thumb (512px) or preview (1280px) AVIF into the
        /// local cache and return its path — GET /api/thumb/:slug/* and
        /// /api/preview/:slug/*, the unified `slug:relPath` routes the web
        /// grid reads, so the Windows browse grid hits the same server cache
        /// entry. The thumb route renders a file the indexer hasn't reached
        /// yet on the fly; the preview route answers 202 until the asset is
        /// catalogued (the /api/fs/dir listing enqueues a discover scan for
        /// every un-indexed file it returns, so that window is short) —
        /// retried once after the advertised delay; null on failure.</summary>
        public Task<string?> FetchImageAsync(
            string kind, string address, CancellationToken ct) =>
            FetchCachedImageAsync(
                kind, $"{kind}|{address}", $"api/{kind}/{EncodeAddress(address)}", ct);

        /// <summary>slug:relPath → enc(slug)/enc(seg1)/enc(seg2)… — the server
        /// decodes each segment individually.</summary>
        private static string EncodeAddress(string address)
        {
            var (slug, relPath) = SplitAddress(address);
            var segments = relPath
                .Split('/', StringSplitOptions.RemoveEmptyEntries)
                .Select(Uri.EscapeDataString);
            return string.Join("/", new[] { Uri.EscapeDataString(slug) }.Concat(segments));
        }

        private static (string Slug, string RelPath) SplitAddress(string address)
        {
            var colon = address.IndexOf(':');
            return colon < 0 ? (address, string.Empty) : (address[..colon], address[(colon + 1)..]);
        }
    }
}

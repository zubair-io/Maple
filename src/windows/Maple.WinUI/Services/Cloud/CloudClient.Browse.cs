using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>Library browsing (folders + one directory level at a time
    /// through the unified `slug:relPath` listing every client reads) and
    /// address-keyed thumb/preview fetch into the local AVIF disk
    /// cache.</summary>
    public sealed partial class CloudClient
    {
        // --- Library browsing ---

        public Task<CloudFolder[]?> GetFoldersAsync(CancellationToken ct) =>
            GetJsonAsync<CloudFolder[]>("api/folders", ct);

        /// <summary>One cursor-paged directory from the unified address route.
        /// Null on any failure: browsing runs from async void handlers. No
        /// `stack`, so RAW+JPEG companions stay separate entries (Browse folds
        /// them itself). A 409 on the first page (no cursor) is asked for once
        /// more; a later page is not, as it could join two folders.</summary>
        public Task<CloudFolderListing?> ListFolderAddressAsync(
            string address, string? cursor, int limit, CancellationToken ct)
        {
            if (limit is < 1 or > 2000) throw new ArgumentOutOfRangeException(nameof(limit));
            var query = $"api/folder/{EncodeAddress(address)}?limit={limit}";
            if (!string.IsNullOrEmpty(cursor))
                query += $"&cursor={Uri.EscapeDataString(cursor)}";
            return GetJsonAsync<CloudFolderListing>(query, ct, retryOnConflict: string.IsNullOrEmpty(cursor));
        }

        // --- Images (AVIF, disk-cached) ---

        /// <summary>Fetch a thumb (512px) or preview (1280px) AVIF into the
        /// local cache and return its path — GET /api/thumb/:slug/* and
        /// /api/preview/:slug/*, the unified `slug:relPath` routes the web
        /// grid reads, so the Windows browse grid hits the same server cache
        /// entry. The thumb route renders a file the indexer hasn't reached
        /// yet on the fly; the preview route answers 202 until the asset is
        /// catalogued (the folder listing enqueues a discover scan for
        /// every un-indexed file it returns, so that window is short) —
        /// retried once after the advertised delay; null on failure. A
        /// <paramref name="version"/> is the listing's thumbnail token: it
        /// rides in the query string only, the cached copy that already
        /// holds that token is returned without a request, and any other
        /// token fetches fresh bytes that replace it.</summary>
        public Task<string?> FetchImageAsync(
            string kind, string address, CancellationToken ct, string? version = null) =>
            FetchCachedImageAsync(
                kind, $"{kind}|{address}", $"api/{kind}/{EncodeAddress(address)}", version, ct);

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

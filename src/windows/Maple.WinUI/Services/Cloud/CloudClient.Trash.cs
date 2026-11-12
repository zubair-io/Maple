using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>Culling sync (rating/flag/color-label merged into the
    /// server-side sidecar), Trash/restore (#2741 — resolve a server path
    /// to its indexed asset id, soft-delete, restore, and one page of a
    /// library's server-side Trash), and opening a library file's bytes as
    /// a headers-read stream (#2589) for the Cloud Files hydration
    /// callback.</summary>
    public sealed partial class CloudClient
    {
        // --- Culling sync (POST /api/xmp/batch merges with the sidecar) ---

        public async Task<bool> WriteCullingAsync(
            string address, int rating, string flagStatus, string? colorLabel, CancellationToken ct)
        {
            var flag = flagStatus switch
            {
                "pick" => "pick",
                "reject" => "reject",
                _ => "unflagged",
            };
            var payload = new
            {
                entries = new[]
                {
                    new
                    {
                        address,
                        metadata = new Dictionary<string, object?>
                        {
                            ["rating"] = rating,
                            ["flag"] = flag,
                            ["colorLabel"] = colorLabel,
                        },
                    },
                },
            };
            using var response = await SendAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "api/xmp/batch")
                {
                    Content = JsonContent(payload),
                }, ct);
            if (!response.IsSuccessStatusCode)
                DiagLog.Write($"[cloud] xmp/batch {(int)response.StatusCode} for {address}");
            return response.IsSuccessStatusCode;
        }

        // --- Trash / restore (#2741) ---

        /// <summary>Resolves a server absolute path (the /api/fs/dir
        /// listing's `path`, which cloud PhotoItems carry as FilePath) to
        /// its indexed asset id via GET /api/assets/by-fspath. Null when
        /// the path isn't in any registered library or the indexer hasn't
        /// reached the file yet — the caller surfaces that as a per-item
        /// failure rather than guessing.</summary>
        public Task<CloudAssetRef?> ResolveAssetAsync(string serverAbsPath, CancellationToken ct) =>
            GetJsonAsync<CloudAssetRef>(
                $"api/assets/by-fspath?path={Uri.EscapeDataString(serverAbsPath)}", ct);

        /// <summary>Sends one asset to the server's Trash.
        /// `intent=trash` pins the dual-mode DELETE route to its
        /// soft-delete branch (the same guard the web client passes), so a
        /// double-fired delete can never escalate into the permanent-purge
        /// branch.</summary>
        public async Task<bool> TrashAssetAsync(string assetId, CancellationToken ct)
        {
            using var response = await SendAsync(
                () => new HttpRequestMessage(
                    HttpMethod.Delete, $"api/assets/{Uri.EscapeDataString(assetId)}?intent=trash"), ct);
            if (!response.IsSuccessStatusCode)
                DiagLog.Write($"[cloud] DELETE assets/{assetId} → {(int)response.StatusCode}");
            return response.IsSuccessStatusCode;
        }

        /// <summary>Restores one trashed asset to its original server
        /// location (POST /api/assets/:id/restore). Empty JSON body, same
        /// as the web client.</summary>
        public async Task<bool> RestoreAssetAsync(string assetId, CancellationToken ct)
        {
            using var response = await SendAsync(
                () => new HttpRequestMessage(
                    HttpMethod.Post, $"api/assets/{Uri.EscapeDataString(assetId)}/restore")
                {
                    Content = JsonContent(new { }),
                }, ct);
            if (!response.IsSuccessStatusCode)
                DiagLog.Write($"[cloud] restore assets/{assetId} → {(int)response.StatusCode}");
            return response.IsSuccessStatusCode;
        }

        /// <summary>One newest-first page of a library's server-side Trash
        /// (GET /api/folders/:id/trash).</summary>
        public Task<CloudTrashPage?> ListTrashAsync(
            string folderId, int limit, string? cursor, CancellationToken ct)
        {
            var route = $"api/folders/{Uri.EscapeDataString(folderId)}/trash?limit={limit}";
            if (!string.IsNullOrEmpty(cursor))
                route += $"&cursor={Uri.EscapeDataString(cursor)}";
            return GetJsonAsync<CloudTrashPage>(route, ct);
        }

        // --- Library file bytes as a stream (#2589, #5852) ---

        /// <summary>Opens the bytes of the library file at a `slug:relPath`
        /// address as a headers-read response for streaming consumers (the
        /// Cloud Files hydration callback) that must not spool the whole
        /// file to disk first. The caller owns the response and must dispose
        /// it — the content stream dies with it. Null on any non-success.
        ///
        /// GET /api/image/:slug/* first: it carries the #926 mirror failover.
        /// That route streams only image, stub and audio types and answers
        /// 415 for the rest (video, sidecars, ordinary files), which
        /// GET /api/folders/:id/file?path= streams by library-relative path —
        /// the pair the Apple File Provider reads non-asset files
        /// through.</summary>
        public async Task<HttpResponseMessage?> OpenLibraryFileAsync(string address, CancellationToken ct)
        {
            var image = await SendStreamAsync(
                () => new HttpRequestMessage(HttpMethod.Get, $"api/image/{EncodeAddress(address)}"), ct);
            if (image.StatusCode != HttpStatusCode.UnsupportedMediaType)
                return SuccessOrNull(image, address);
            image.Dispose();

            var (slug, relPath) = SplitAddress(address);
            var libraries = await GetFoldersAsync(ct);
            var library = Array.Find(libraries ?? Array.Empty<CloudFolder>(), folder => folder.Slug == slug);
            if (library == null)
            {
                DiagLog.Write($"[cloud] no library for {address}");
                return null;
            }
            var file = await SendStreamAsync(
                () => new HttpRequestMessage(HttpMethod.Get,
                    $"api/folders/{Uri.EscapeDataString(library.Id)}/file?path={Uri.EscapeDataString(relPath)}"),
                ct);
            return SuccessOrNull(file, address);
        }

        private static HttpResponseMessage? SuccessOrNull(HttpResponseMessage response, string address)
        {
            if (response.IsSuccessStatusCode)
                return response;
            DiagLog.Write($"[cloud] file open {(int)response.StatusCode} for {address}");
            response.Dispose();
            return null;
        }
    }
}

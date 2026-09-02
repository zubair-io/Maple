using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>Culling sync (rating/flag/color-label merged into the
    /// server-side sidecar), Trash/restore (#2741 — resolve a server path
    /// to its indexed asset id, soft-delete, restore, and one page of a
    /// library's server-side Trash), and opening the original bytes as a
    /// headers-read stream (#2589) for the Cloud Files hydration
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

        // --- Original bytes as a stream (#2589) ---

        /// <summary>Opens GET /api/fs/raw as a headers-read response for
        /// streaming consumers (the Cloud Files hydration callback) that
        /// must not spool the whole RAW to disk first. The caller owns the
        /// response and must dispose it — the content stream dies with it.
        /// Null on any non-success status.</summary>
        public async Task<HttpResponseMessage?> OpenOriginalAsync(
            string serverAbsPath, CancellationToken ct)
        {
            var route = $"api/fs/raw?path={Uri.EscapeDataString(serverAbsPath)}";
            var response = await SendStreamAsync(
                () => new HttpRequestMessage(HttpMethod.Get, route), ct);
            if (response.IsSuccessStatusCode)
                return response;
            DiagLog.Write($"[cloud] raw open {(int)response.StatusCode} for {serverAbsPath}");
            response.Dispose();
            return null;
        }
    }
}

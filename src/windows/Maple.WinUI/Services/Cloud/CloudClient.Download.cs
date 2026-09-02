using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>Download-to-edit (#2588): the original RAW/image streamed
    /// into a local cache with progress reporting, the full-sidecar
    /// get/overwrite pair, publishing a freshly developed preview back to
    /// the server, and the header-read send used for large streamed
    /// bodies (a buffered send would hold a whole RAW in memory and trip
    /// the client's 30s timeout).</summary>
    public sealed partial class CloudClient
    {
        // --- Download-to-edit (#2588): original bytes, full sidecars, preview publish ---

        /// <summary>Stream the original RAW/image into the local cache and
        /// return its path (GET /api/fs/raw?path= — the same route the Apple
        /// cloud source uses; mirror-aware and ETag'd server-side). A cached
        /// copy matching the server-reported size is reused without a request.
        /// Progress is (bytesReceived, totalBytes; total -1 when unknown).</summary>
        public async Task<string?> DownloadOriginalAsync(
            string serverAbsPath, long expectedSize,
            Action<long, long>? progress, CancellationToken ct)
        {
            // Keyed by the path this actually fetches, not by the asset's
            // `slug:relPath` address: the address is optional (a library with
            // no registered slug has none), and two files sharing a cache key
            // is a correctness bug, not a cosmetic one.
            var hash = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes($"{ServerUrl}|original|{serverAbsPath}")))[..32];
            var originalsDir = Path.Combine(_cacheDir, "originals");
            Directory.CreateDirectory(originalsDir);
            var fileName = Path.GetFileName(serverAbsPath.Replace('\\', '/'));
            var cachePath = Path.Combine(originalsDir, $"{hash}-{fileName}");
            if (File.Exists(cachePath)
                && (expectedSize <= 0 || new FileInfo(cachePath).Length == expectedSize))
                return cachePath;

            var route = $"api/fs/raw?path={Uri.EscapeDataString(serverAbsPath)}";
            using var response = await SendStreamAsync(
                () => new HttpRequestMessage(HttpMethod.Get, route), ct);
            if (!response.IsSuccessStatusCode)
            {
                DiagLog.Write($"[cloud] original download {(int)response.StatusCode} for {fileName}");
                return null;
            }
            var total = response.Content.Headers.ContentLength ?? -1;
            var tempPath = cachePath + ".tmp";
            try
            {
                await using (var body = await response.Content.ReadAsStreamAsync(ct))
                await using (var file = File.Create(tempPath))
                {
                    var buffer = new byte[1 << 20];
                    long received = 0;
                    int read;
                    while ((read = await body.ReadAsync(buffer, ct)) > 0)
                    {
                        await file.WriteAsync(buffer.AsMemory(0, read), ct);
                        received += read;
                        progress?.Invoke(received, total);
                    }
                }
                File.Move(tempPath, cachePath, overwrite: true);
                return cachePath;
            }
            catch
            {
                try { File.Delete(tempPath); } catch { /* best effort */ }
                throw;
            }
        }

        /// <summary>The full server-side sidecar document, or null when the
        /// asset has none yet (404) or the request failed.</summary>
        public async Task<string?> GetXmpAsync(string serverAbsPath, CancellationToken ct)
        {
            var route = $"api/xmp?path={Uri.EscapeDataString(serverAbsPath)}";
            using var response = await SendAsync(
                () => new HttpRequestMessage(HttpMethod.Get, route), ct);
            if (response.StatusCode == HttpStatusCode.NotFound)
                return null;
            if (!response.IsSuccessStatusCode)
            {
                DiagLog.Write($"[cloud] GET xmp → {(int)response.StatusCode}");
                return null;
            }
            return await response.Content.ReadAsStringAsync(ct);
        }

        /// <summary>Overwrite the server-side sidecar (atomic on the server).
        /// The document must be the FULL sidecar — passthrough fields intact —
        /// because this route replaces byte-for-byte, no merge.</summary>
        public async Task<bool> PostXmpAsync(string serverAbsPath, string xml, CancellationToken ct)
        {
            var route = $"api/xmp?path={Uri.EscapeDataString(serverAbsPath)}";
            using var response = await SendAsync(
                () => new HttpRequestMessage(HttpMethod.Post, route)
                {
                    Content = new StringContent(xml, Encoding.UTF8, "application/xml"),
                }, ct);
            if (!response.IsSuccessStatusCode)
                DiagLog.Write($"[cloud] POST xmp → {(int)response.StatusCode}");
            return response.IsSuccessStatusCode;
        }

        /// <summary>Publish a freshly developed JPEG preview for the asset
        /// (PUT /api/preview?path= — the server transcodes to AVIF and swaps
        /// it into its preview cache). Best-effort: false is non-fatal.</summary>
        public async Task<bool> PublishPreviewAsync(
            string serverAbsPath, byte[] jpegBytes, CancellationToken ct)
        {
            var route = $"api/preview?path={Uri.EscapeDataString(serverAbsPath)}";
            using var response = await SendAsync(
                () => new HttpRequestMessage(HttpMethod.Put, route)
                {
                    Content = new ByteArrayContent(jpegBytes)
                    {
                        Headers = { ContentType = new MediaTypeHeaderValue("image/jpeg") },
                    },
                }, ct);
            if (!response.IsSuccessStatusCode)
                DiagLog.Write($"[cloud] PUT preview → {(int)response.StatusCode}");
            return response.IsSuccessStatusCode;
        }

        /// <summary>Header-read send for large streamed bodies — the buffered
        /// SendAsync would hold a whole RAW in memory and trip the 30s client
        /// timeout, which only covers headers on this path.</summary>
        private async Task<HttpResponseMessage> SendStreamAsync(
            Func<HttpRequestMessage> makeRequest, CancellationToken ct)
        {
            var request = makeRequest();
            if (_accessToken != null)
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
            var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.StatusCode != HttpStatusCode.Unauthorized)
                return response;
            response.Dispose();

            await RefreshAccessTokenAsync(ct);
            var retry = makeRequest();
            if (_accessToken != null)
                retry.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
            return await _http.SendAsync(retry, HttpCompletionOption.ResponseHeadersRead, ct);
        }
    }
}

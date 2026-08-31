using System;
using System.Collections.Generic;
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

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>
    /// Client for the Maple Self-Hosted API (src/api — Bun + Elysia). Bearer
    /// auth with the reference client's 401 → /api/auth/refresh → retry-once
    /// loop (the refresh credential is the httpOnly maple_refresh cookie, held
    /// by the handler's CookieContainer). Thumbs/previews are AVIF, cached on
    /// disk keyed by address hash.
    ///
    /// Replaces the former CloudSyncAgent stub, whose /health,
    /// /api/sidecars/sync and /api/backup/catalog endpoints do not exist on
    /// the server ("/health" even false-passes by hitting the SPA fallback).
    /// </summary>
    public sealed class CloudClient : IDisposable
    {
        private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
        private readonly HttpClient _http;
        private readonly string _cacheDir;
        private string? _accessToken;

        public string ServerUrl { get; }
        public bool IsAuthenticated => _accessToken != null;

        public CloudClient(string serverUrl)
        {
            ServerUrl = serverUrl.TrimEnd('/');
            _http = new HttpClient(new HttpClientHandler
            {
                CookieContainer = new CookieContainer(),
                UseCookies = true,
            })
            {
                BaseAddress = new Uri(ServerUrl + "/"),
                Timeout = TimeSpan.FromSeconds(30),
            };
            _cacheDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Maple", "cloud");
            Directory.CreateDirectory(_cacheDir);
        }

        // --- Connection / auth ---

        /// <summary>The device-scoped refresh token from the native-code
        /// redeem (rotated on every refresh). The caller persists it
        /// DPAPI-protected for silent reconnect.</summary>
        public string? RefreshToken { get; private set; }
        public event Action<string>? RefreshTokenRotated;

        /// <summary>Health + auth-mode probe — step 1 of any connect flow.</summary>
        public async Task<(bool Ok, string Message, bool DevLoginEnabled)> ProbeAsync(CancellationToken ct)
        {
            CloudHealth? health;
            try
            {
                health = await GetJsonAsync<CloudHealth>("api/health", ct, authenticated: false);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or UriFormatException)
            {
                return (false, $"Server unreachable: {ex.Message}", false);
            }
            if (health is not { Ok: true } || health.Product != "maple")
                return (false, "Not a Maple Self-Hosted server (bad /api/health response).", false);
            if (!health.DbConnected)
                return (false, "Server is up but its database is down (db_connected=false).", false);
            var bootstrap = await GetJsonAsync<CloudAuthBootstrap>("api/auth/bootstrap", ct, authenticated: false);
            return (true, $"Connected to {ServerUrl} (v{health.Version}).",
                bootstrap?.DevLoginEnabled == true);
        }

        /// <summary>The browser sign-in URL for the PKCE native-code ceremony:
        /// the web app completes the passkey login, mints a one-time code and
        /// redirects it to maple-app://auth-success (the only scheme the web
        /// allowlists).</summary>
        public string BuildBrowserSignInUrl(string codeChallenge, string state) =>
            $"{ServerUrl}/?native_callback=maple-app" +
            $"&code_challenge={Uri.EscapeDataString(codeChallenge)}" +
            $"&state={Uri.EscapeDataString(state)}";

        /// <summary>Redeem the one-time code + private PKCE verifier for
        /// device-scoped tokens (POST /api/auth/native-code/redeem).</summary>
        public async Task<(bool Ok, string Message)> RedeemNativeCodeAsync(
            string code, string codeVerifier, CancellationToken ct)
        {
            using var response = await _http.PostAsync("api/auth/native-code/redeem",
                JsonContent(new { code, code_verifier = codeVerifier }), ct);
            if (!response.IsSuccessStatusCode)
                return (false, $"code redeem failed ({(int)response.StatusCode}) — the code may have expired; try signing in again.");
            var tokens = await ReadJsonAsync<CloudRedeemResponse>(response, ct);
            if (string.IsNullOrEmpty(tokens?.AccessToken))
                return (false, "code redeem returned no access token.");
            _accessToken = tokens!.AccessToken;
            RefreshToken = tokens.RefreshToken;
            return (true, $"Signed in as {tokens.User?.Email ?? "user"}.");
        }

        /// <summary>Poll-claim the pending ceremony's code by state + private
        /// PKCE verifier (POST /api/auth/native-code/claim, #3063). The
        /// completion channel that does not depend on the browser launching
        /// maple-app:// — Chromium refuses that launch without a user gesture,
        /// which is exactly the already-signed-in-browser case. Returns
        /// Ok=true once signed in. Ok=false + Fatal=false means keep polling:
        /// 404 (nothing pending yet), 429 (rate-limited), 5xx and network
        /// errors are all transient here. Ok=false + Fatal=true is a
        /// permanent, operator-visible failure (bad request, user deleted) —
        /// the ceremony can never complete, so stop polling and surface it.</summary>
        public async Task<(bool Ok, bool Fatal, string Message)> ClaimNativeCodeAsync(
            string state, string codeVerifier, CancellationToken ct)
        {
            try
            {
                using var response = await _http.PostAsync("api/auth/native-code/claim",
                    JsonContent(new { state, code_verifier = codeVerifier }), ct);
                var status = (int)response.StatusCode;
                if (status == 404 || status == 429 || status >= 500)
                    return (false, false, $"no code yet ({status})");
                if (!response.IsSuccessStatusCode)
                    return (false, true, $"sign-in claim rejected ({status}).");
                var tokens = await ReadJsonAsync<CloudRedeemResponse>(response, ct);
                if (string.IsNullOrEmpty(tokens?.AccessToken))
                    return (false, true, "claim returned no access token.");
                _accessToken = tokens!.AccessToken;
                RefreshToken = tokens.RefreshToken;
                return (true, false, $"Signed in as {tokens.User?.Email ?? "user"}.");
            }
            catch (HttpRequestException ex)
            {
                return (false, false, $"claim unreachable: {ex.Message}");
            }
        }

        /// <summary>Silent reconnect from a persisted refresh token
        /// (POST /api/auth/refresh with the body token; server rotates it).</summary>
        public async Task<bool> RestoreSessionAsync(string refreshToken, CancellationToken ct)
        {
            RefreshToken = refreshToken;
            return await RefreshAccessTokenAsync(ct);
        }

        /// <summary>Dev-only fallback (server started with MAPLE_DEV_AUTH=1);
        /// no email needed — the server defaults the dev identity.</summary>
        public async Task<(bool Ok, string Message)> DevLoginAsync(CancellationToken ct)
        {
            using var response = await _http.PostAsync("api/auth/dev-login",
                JsonContent(new Dictionary<string, string?>()), ct);
            if (!response.IsSuccessStatusCode)
                return (false, $"dev-login failed ({(int)response.StatusCode}).");
            var token = await ReadJsonAsync<CloudTokenResponse>(response, ct);
            if (string.IsNullOrEmpty(token?.AccessToken))
                return (false, "dev-login returned no access token.");
            _accessToken = token!.AccessToken;
            return (true, "Signed in (dev).");
        }

        private async Task<bool> RefreshAccessTokenAsync(CancellationToken ct)
        {
            // Native clients refresh with the body token (the cookie variant is
            // the browser's); the server rotates and returns a fresh raw token.
            var payload = RefreshToken != null
                ? JsonContent(new { refresh_token = RefreshToken })
                : JsonContent(new Dictionary<string, string?>());
            using var refresh = await _http.PostAsync("api/auth/refresh", payload, ct);
            if (!refresh.IsSuccessStatusCode)
            {
                DiagLog.Write($"[cloud] refresh -> {(int)refresh.StatusCode} "
                    + await refresh.Content.ReadAsStringAsync(ct));
                return false;
            }
            var tokens = await ReadJsonAsync<CloudRedeemResponse>(refresh, ct);
            if (string.IsNullOrEmpty(tokens?.AccessToken))
            {
                DiagLog.Write("[cloud] refresh returned no access token");
                return false;
            }
            _accessToken = tokens!.AccessToken;
            if (!string.IsNullOrEmpty(tokens.RefreshToken))
            {
                RefreshToken = tokens.RefreshToken;
                RefreshTokenRotated?.Invoke(tokens.RefreshToken!);
            }
            return true;
        }

        // --- Library browsing ---

        public Task<CloudFolder[]?> GetFoldersAsync(CancellationToken ct) =>
            GetJsonAsync<CloudFolder[]>("api/folders", ct);

        /// <summary>One directory level (GET /api/fs/dir) — the same endpoint
        /// the Apple cloud source browses with, so Windows sees exactly the
        /// tree Finder does. Pass the previous page's NextCursor to continue a
        /// large directory; omitting both cursor and limit asks for the whole
        /// listing in one shot (the server's historical default).</summary>
        public Task<CloudDirListing?> ListDirAsync(
            string absPath, string? cursor, int limit, CancellationToken ct)
        {
            var query = $"api/fs/dir?path={Uri.EscapeDataString(absPath)}&limit={limit}";
            if (!string.IsNullOrEmpty(cursor))
                query += $"&cursor={Uri.EscapeDataString(cursor)}";
            return GetJsonAsync<CloudDirListing>(query, ct);
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

        // --- Plumbing: bearer + 401 → refresh → retry once ---

        private async Task<HttpResponseMessage> SendAsync(
            Func<HttpRequestMessage> makeRequest, CancellationToken ct)
        {
            var response = await SendOnceAsync(makeRequest(), ct);
            if (response.StatusCode != HttpStatusCode.Unauthorized)
                return response;
            response.Dispose();

            await RefreshAccessTokenAsync(ct);
            return await SendOnceAsync(makeRequest(), ct);
        }

        private Task<HttpResponseMessage> SendOnceAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (_accessToken != null)
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
            return _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, ct);
        }

        private async Task<T?> GetJsonAsync<T>(
            string route, CancellationToken ct, bool authenticated = true) where T : class
        {
            using var response = authenticated
                ? await SendAsync(() => new HttpRequestMessage(HttpMethod.Get, route), ct)
                : await _http.GetAsync(route, ct);
            if (!response.IsSuccessStatusCode)
            {
                DiagLog.Write($"[cloud] GET {route} → {(int)response.StatusCode}");
                return null;
            }
            return await ReadJsonAsync<T>(response, ct);
        }

        private static async Task<T?> ReadJsonAsync<T>(
            HttpResponseMessage response, CancellationToken ct) where T : class
        {
            var text = await response.Content.ReadAsStringAsync(ct);
            try
            {
                return JsonSerializer.Deserialize<T>(text, Json);
            }
            catch (JsonException ex)
            {
                DiagLog.Write($"[cloud] bad JSON: {ex.Message}");
                return null;
            }
        }

        private static StringContent JsonContent(object payload) =>
            new(JsonSerializer.Serialize(payload, Json), Encoding.UTF8, "application/json");

        public void Dispose() => _http.Dispose();
    }
}

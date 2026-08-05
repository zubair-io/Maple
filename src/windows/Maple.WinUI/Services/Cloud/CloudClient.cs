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

        /// <summary>Health-check the server and authenticate. Dev-login is the
        /// only non-interactive path today (requires MAPLE_DEV_AUTH=1 server
        /// side); passkey/native-code auth is the production follow-up.</summary>
        public async Task<(bool Ok, string Message)> ConnectAsync(string? email, CancellationToken ct)
        {
            CloudHealth? health;
            try
            {
                health = await GetJsonAsync<CloudHealth>("api/health", ct, authenticated: false);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or UriFormatException)
            {
                return (false, $"Server unreachable: {ex.Message}");
            }
            if (health is not { Ok: true } || health.Product != "maple")
                return (false, "Not a Maple Self-Hosted server (bad /api/health response).");
            if (!health.DbConnected)
                return (false, "Server is up but its database is down (db_connected=false).");

            var bootstrap = await GetJsonAsync<CloudAuthBootstrap>("api/auth/bootstrap", ct, authenticated: false);
            if (bootstrap is not { DevLoginEnabled: true })
                return (false,
                    "Server requires passkey sign-in, which the Windows client does not support yet. " +
                    "Start the server with MAPLE_DEV_AUTH=1 to use dev-login.");

            var body = JsonContent(new Dictionary<string, string?> { ["email"] = email });
            using var response = await _http.PostAsync("api/auth/dev-login", body, ct);
            if (!response.IsSuccessStatusCode)
                return (false, $"dev-login failed ({(int)response.StatusCode}).");
            var token = await ReadJsonAsync<CloudTokenResponse>(response, ct);
            if (string.IsNullOrEmpty(token?.AccessToken))
                return (false, "dev-login returned no access token.");
            _accessToken = token.AccessToken;
            return (true, $"Connected to {ServerUrl} (v{health.Version}).");
        }

        // --- Library browsing ---

        public Task<CloudFolder[]?> GetFoldersAsync(CancellationToken ct) =>
            GetJsonAsync<CloudFolder[]>("api/folders", ct);

        /// <summary>One page of the grid feed, newest capture first. Follow
        /// NextCursor until null.</summary>
        public Task<CloudSearchPage?> SearchAsync(
            string? libraryId, string? cursor, int limit, CancellationToken ct)
        {
            var query = $"api/search?sort=captured_desc&limit={limit}";
            if (!string.IsNullOrEmpty(libraryId))
                query += $"&libraryId={Uri.EscapeDataString(libraryId)}";
            if (!string.IsNullOrEmpty(cursor))
                query += $"&cursor={Uri.EscapeDataString(cursor)}";
            return GetJsonAsync<CloudSearchPage>(query, ct);
        }

        // --- Images (AVIF, disk-cached) ---

        /// <summary>Fetch a thumb (512px) or preview (1280px) AVIF into the
        /// local cache and return its path. 202 means still indexing — retried
        /// once after the advertised delay; null on failure.</summary>
        public async Task<string?> FetchImageAsync(
            string kind, string address, CancellationToken ct)
        {
            var hash = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes($"{ServerUrl}|{kind}|{address}")))[..32];
            var cachePath = Path.Combine(_cacheDir, $"{hash}-{kind}.avif");
            if (File.Exists(cachePath))
                return cachePath;

            var route = $"api/{kind}/{EncodeAddress(address)}";
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

            using var refresh = await _http.PostAsync("api/auth/refresh", null, ct);
            if (refresh.IsSuccessStatusCode)
            {
                var token = await ReadJsonAsync<CloudTokenResponse>(refresh, ct);
                if (!string.IsNullOrEmpty(token?.AccessToken))
                    _accessToken = token.AccessToken;
            }
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

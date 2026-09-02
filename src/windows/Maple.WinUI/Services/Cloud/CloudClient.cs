using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
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
    ///
    /// Split across partials by concern (#3119): this file holds
    /// construction and the shared bearer + 401-retry plumbing every other
    /// partial calls into. See CloudClient.SignIn.cs (passkey/PKCE
    /// ceremony), CloudClient.Auth.cs (session restore + token refresh),
    /// CloudClient.Browse.cs (folder/directory listing + thumb/preview
    /// fetch), CloudClient.Download.cs (download-to-edit: original bytes,
    /// sidecar get/put, preview publish), and CloudClient.Trash.cs
    /// (culling sync, Trash/restore, raw-bytes streaming).
    /// </summary>
    public sealed partial class CloudClient : IDisposable
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

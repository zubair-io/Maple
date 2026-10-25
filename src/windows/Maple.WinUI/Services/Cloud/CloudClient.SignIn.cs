using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>Sign-in ceremonies: the health/auth-mode probe, the browser
    /// passkey/PKCE flow's URL builder and callback-code redeem.</summary>
    public sealed partial class CloudClient
    {
        // --- Connection / auth ---

        /// <summary>The device-scoped refresh token from the native-code
        /// redeem (rotated on every refresh). The caller persists it
        /// DPAPI-protected for silent reconnect.</summary>
        public string? RefreshToken { get; private set; }
        public event Action<string>? RefreshTokenRotated;

        /// <summary>Duplicate callbacks consume the same single-use code; only
        /// one redeems it and later callbacks adopt its tokens.</summary>
        private readonly SemaphoreSlim _signInGate = new(1, 1);
        private string? _signedInMessage;

        /// <summary>Health + auth-mode probe — step 1 of any connect flow.</summary>
        public async Task<(bool Ok, string Message, bool DevLoginEnabled)> ProbeAsync(CancellationToken ct)
        {
            CloudHealth? health;
            try
            {
                health = await GetJsonAsync<CloudHealth>(
                    "api/health", ct, authenticated: false, reportTransportFailureAsNull: false);
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
        public async Task<(bool Ok, string Message, bool Retryable)> RedeemNativeCodeAsync(
            string code, string codeVerifier, CancellationToken ct)
        {
            await _signInGate.WaitAsync(ct);
            try
            {
                return _signedInMessage is { } done
                    ? (true, done, false)
                    : await RedeemNativeCodeCoreAsync(code, codeVerifier, ct);
            }
            finally
            {
                _signInGate.Release();
            }
        }

        private async Task<(bool Ok, string Message, bool Retryable)> RedeemNativeCodeCoreAsync(
            string code, string codeVerifier, CancellationToken ct)
        {
            using var response = await PostRedeemAsync(code, codeVerifier, ct);
            if (response == null)
                return (false, "code redeem could not reach the server — check your connection and try signing in again.", false);
            if (!response.IsSuccessStatusCode)
                return (false, $"code redeem failed ({(int)response.StatusCode}) — the code may have expired; try signing in again.",
                    (int)response.StatusCode == 429);
            var tokens = await ReadJsonAsync<CloudRedeemResponse>(response, ct);
            if (string.IsNullOrEmpty(tokens?.AccessToken))
                return (false, "code redeem returned no access token.", false);
            _accessToken = tokens!.AccessToken;
            RefreshToken = tokens.RefreshToken;
            _signedInMessage = $"Signed in as {tokens.User?.Email ?? "user"}.";
            return (true, _signedInMessage, false);
        }

        private async Task<HttpResponseMessage?> PostRedeemAsync(string code, string codeVerifier, CancellationToken ct)
        {
            try
            {
                return await _http.PostAsync("api/auth/native-code/redeem",
                    JsonContent(new { code, code_verifier = codeVerifier }), ct);
            }
            catch (Exception ex) when (
                ex is HttpRequestException || (ex is TaskCanceledException && !ct.IsCancellationRequested))
            {
                DiagLog.Write($"[cloud] redeem unreachable: {ex.Message}");
                return null;
            }
        }

    }
}

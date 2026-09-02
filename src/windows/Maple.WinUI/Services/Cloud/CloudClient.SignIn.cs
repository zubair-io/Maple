using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>Sign-in ceremonies: the health/auth-mode probe, the browser
    /// passkey/PKCE flow's URL builder and one-time-code redeem, and the
    /// poll-based claim variant (#3063) used when the browser can't launch
    /// the maple-app:// callback itself.</summary>
    public sealed partial class CloudClient
    {
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
    }
}

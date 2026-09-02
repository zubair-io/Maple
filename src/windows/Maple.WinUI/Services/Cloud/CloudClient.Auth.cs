using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>Session establishment: silent reconnect from a persisted
    /// refresh token, the dev-only MAPLE_DEV_AUTH=1 fallback, and the shared
    /// refresh implementation (POST /api/auth/refresh, rotating the stored
    /// token) that both this partial and the bearer-401 retry in the root
    /// file's plumbing call into.</summary>
    public sealed partial class CloudClient
    {
        /// <summary>Silent reconnect from a persisted refresh token
        /// (POST /api/auth/refresh with the body token; server rotates it).
        /// The caller must distinguish the two failure modes — see
        /// <see cref="RefreshOutcome"/>.</summary>
        public async Task<RefreshOutcome> RestoreSessionAsync(
            string refreshToken, CancellationToken ct)
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

        private async Task<RefreshOutcome> RefreshAccessTokenAsync(CancellationToken ct)
        {
            // Native clients refresh with the body token (the cookie variant is
            // the browser's); the server rotates and returns a fresh raw token.
            var payload = RefreshToken != null
                ? JsonContent(new { refresh_token = RefreshToken })
                : JsonContent(new Dictionary<string, string?>());
            HttpResponseMessage refresh;
            try
            {
                refresh = await _http.PostAsync("api/auth/refresh", payload, ct);
            }
            catch (Exception ex) when (
                ex is HttpRequestException
                || (ex is TaskCanceledException && !ct.IsCancellationRequested))
            {
                // Offline, DNS failure, server down — the stored credential
                // says nothing about any of these. A TaskCanceledException
                // with the caller's token unsignalled is HttpClient's own
                // 30s timeout (a hung or very slow server), which is just as
                // transient; a signalled token is real cancellation and is
                // left to propagate.
                DiagLog.Write($"[cloud] refresh unreachable: {ex.Message}");
                return RefreshOutcome.Transient;
            }
            using var _ = refresh;
            if (!refresh.IsSuccessStatusCode)
            {
                var status = (int)refresh.StatusCode;
                DiagLog.Write($"[cloud] refresh -> {status} "
                    + await refresh.Content.ReadAsStringAsync(ct));
                // Only the origin saying "this credential is no good" is
                // grounds for discarding it, and on /api/auth/refresh that is
                // exactly 401 (plus 400 for a malformed request that can never
                // succeed). NOT 403: the origin never uses it on this route —
                // its 403s are role/permission/step-up gates elsewhere — so a
                // 403 here is a reverse proxy or WAF speaking for itself, and
                // treating a middlebox rule as credential rejection would
                // delete a valid session. 429 (rate-limited to 10/min/IP),
                // 409 (rotation conflict) and 5xx say nothing about the token.
                return status is 400 or 401
                    ? RefreshOutcome.Rejected
                    : RefreshOutcome.Transient;
            }
            var tokens = await ReadJsonAsync<CloudRedeemResponse>(refresh, ct);
            if (string.IsNullOrEmpty(tokens?.AccessToken))
            {
                // A 2xx that carries no token is a server-side malfunction,
                // not a verdict on the credential.
                DiagLog.Write("[cloud] refresh returned no access token");
                return RefreshOutcome.Transient;
            }
            _accessToken = tokens!.AccessToken;
            if (!string.IsNullOrEmpty(tokens.RefreshToken))
            {
                RefreshToken = tokens.RefreshToken;
                RefreshTokenRotated?.Invoke(tokens.RefreshToken!);
            }
            return RefreshOutcome.Ok;
        }
    }
}

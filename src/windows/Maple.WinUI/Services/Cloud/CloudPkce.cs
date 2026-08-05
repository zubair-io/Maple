using System;
using System.Security.Cryptography;
using System.Text;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>One pending browser sign-in ceremony (#856 PKCE): the verifier
    /// never leaves the app; the web app only ever sees the S256 challenge and
    /// echoes the opaque state back with the one-time code.</summary>
    public sealed record CloudPkcePending(string ServerUrl, string Verifier, string State);

    public static class CloudPkce
    {
        public static CloudPkcePending Begin(string serverUrl)
        {
            var verifier = Base64Url(RandomNumberGenerator.GetBytes(48));   // 64 chars
            var state = Base64Url(RandomNumberGenerator.GetBytes(24));      // 32 chars
            return new CloudPkcePending(serverUrl, verifier, state);
        }

        /// <summary>base64url(sha256(verifier)) — the 43-char S256 challenge the
        /// server validates against on redeem.</summary>
        public static string ChallengeFor(string verifier) =>
            Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

        private static string Base64Url(byte[] bytes) =>
            Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
}

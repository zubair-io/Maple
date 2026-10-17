using System;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    public static class CloudSignInCallback
    {
        public static bool MatchesPending(Uri callback, CloudPkcePending pending, out string code)
        {
            var query = System.Web.HttpUtility.ParseQueryString(callback.Query);
            code = query["code"] ?? "";
            return code.Length > 0 && query["state"] == pending.State;
        }

        public static async Task<(bool Ok, string Message)> RedeemAsync(
            CloudClient client, CloudPkcePending pending, string code)
        {
            try
            {
                return await client.RedeemNativeCodeAsync(code, pending.Verifier, CancellationToken.None);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                DiagLog.Write($"[cloud] sign-in redeem failed: {ex}");
                return (false, ex.Message);
            }
        }
    }
}

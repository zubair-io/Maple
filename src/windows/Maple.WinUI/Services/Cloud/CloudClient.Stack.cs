using System;
using System.Net;
using System.Net.Http;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>The RAW+JPEG stack fields of GET /api/display/config (#5050).
    /// The Browse grid shows a pair as one tile only when the user's
    /// `stack_raw_jpeg` preference is on (the default, also when an older
    /// server omits it) and the server can trash both files in one request
    /// (`stack_pair_ops_supported`); otherwise every file keeps its tile, so
    /// no folded tile can leave its JPEG behind.</summary>
    public sealed class CloudDisplayConfig
    {
        [JsonPropertyName("stack_raw_jpeg")] public bool? StackRawJpeg { get; set; }
        [JsonPropertyName("stack_pair_ops_supported")] public bool? StackPairOpsSupported { get; set; }

        public bool FoldsRawJpegStacks => StackRawJpeg != false && StackPairOpsSupported == true;
    }

    public enum CloudStackTrashResult
    {
        Trashed,
        Missing,
        AlreadyTrashed,
        Refused,
    }

    public sealed partial class CloudClient
    {
        public Task<CloudDisplayConfig?> GetDisplayConfigAsync(CancellationToken ct) =>
            GetJsonAsync<CloudDisplayConfig>("api/display/config", ct);

        /// <summary>Sends a RAW and its stacked JPEG to the server's Trash in
        /// one request (DELETE /api/assets/:rawId?intent=trash&amp;companion=,
        /// #5930): both rows are trashed or neither is.</summary>
        public async Task<CloudStackTrashResult> TrashStackAsync(
            string rawAssetId, string jpegAssetId, CancellationToken ct)
        {
            var route = $"api/assets/{Uri.EscapeDataString(rawAssetId)}"
                + $"?intent=trash&companion={Uri.EscapeDataString(jpegAssetId)}";
            using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Delete, route), ct);
            if (response.IsSuccessStatusCode)
                return CloudStackTrashResult.Trashed;
            DiagLog.Write($"[cloud] DELETE assets/{rawAssetId} with companion → {(int)response.StatusCode}");
            return response.StatusCode switch
            {
                HttpStatusCode.NotFound => CloudStackTrashResult.Missing,
                HttpStatusCode.Conflict => CloudStackTrashResult.AlreadyTrashed,
                _ => CloudStackTrashResult.Refused,
            };
        }
    }
}

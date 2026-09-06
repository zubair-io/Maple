using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Export;

namespace Maple.WinUI.Services.Cloud;

public sealed partial class CloudClient
{
    /// <summary>Export cannot interpret permission, server, or transport errors as default edits.</summary>
    public async Task<string?> GetExportXmpAsync(string serverAbsPath, CancellationToken cancellation)
    {
        var route = $"api/xmp?path={Uri.EscapeDataString(serverAbsPath)}";
        using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Get, route), cancellation);
        return await ExportSnapshot.ReadSidecarResponseAsync(response, cancellation);
    }
}

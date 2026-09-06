using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.Export;

public static class ExportSnapshot
{
    public static async Task<string?> ReadSidecarResponseAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(cancellation);
    }

    public static string Serialize(string? xml, AdjustmentState? activeModel = null)
    {
        var document = xml == null ? new XmpSidecarDocument() : XmpParser.Parse(xml)
            ?? throw new InvalidDataException("Cannot parse the photo's XMP sidecar. Repair it before exporting.");
        if (activeModel != null) document.Adjustments = activeModel.Clone();
        return XmpWriter.Serialize(document);
    }
}

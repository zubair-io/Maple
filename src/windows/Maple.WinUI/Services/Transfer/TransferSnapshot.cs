using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.Transfer;

public sealed record TransferSnapshot(XmpSidecarDocument Document, string? ExpectedHash)
{
    /// <summary>Read the exact local revision used by preview; only a genuinely
    /// absent sidecar uses defaults. Cloud writes merge selected tokens server-side.</summary>
    public static async Task<TransferSnapshot> ReadAsync(string path, CloudClient? cloud, CancellationToken cancellation)
    {
        string? xml;
        string? hash = null;
        if (cloud != null) xml = await cloud.ReadMetadataXmpAsync(path, cancellation);
        else
        {
            var bytes = await Task.Run(() => SidecarStore.ReadSnapshot(path), cancellation);
            hash = SidecarStore.SnapshotHash(bytes);
            if (bytes == null) xml = null;
            else
            {
                using var stream = new MemoryStream(bytes);
                using var reader = new StreamReader(stream, new UTF8Encoding(false, true), true);
                xml = reader.ReadToEnd();
            }
        }
        cancellation.ThrowIfCancellationRequested();
        var document = xml == null ? new XmpSidecarDocument() : XmpParser.Parse(xml)
            ?? throw new InvalidDataException("The existing sidecar cannot be read. It has not been replaced.");
        return new(document, hash);
    }
}

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.Cloud;

public sealed partial class CloudClient
{
    // Serialize this client's read/modify/write operations, including develop
    // autosave and batch keywords (#3878). The server has no conditional XMP
    // write API: this does not claim protection against another client's edits.
    private readonly SemaphoreSlim _sidecarWriteGate = new(1, 1);

    public async Task UpdateDevelopSidecarAsync(string path, AdjustmentState adjustments)
    {
        var snapshot = adjustments.Clone();
        await _sidecarWriteGate.WaitAsync();
        try
        {
            var xml = await ReadMetadataXmpAsync(path, CancellationToken.None);
            var document = ParseEditableSidecar(xml);
            // Culling and keywords belong to metadata writes. Reusing the
            // document captured when editing opened would erase newer values.
            document.Adjustments = snapshot;
            if (!await PostXmpAsync(path, XmpWriter.Serialize(document), CancellationToken.None))
                throw new IOException("Server rejected the adjustment sidecar write.");
        }
        finally { _sidecarWriteGate.Release(); }
    }

    public async Task<MetadataValues> ApplyMetadataAsync(string path, string address,
        MetadataPatch patch, CancellationToken cancellation)
    {
        patch.Validate();
        await _sidecarWriteGate.WaitAsync(cancellation);
        try
        {
            var xml = await ReadMetadataXmpAsync(path, cancellation);
            var document = ParseEditableSidecar(xml);
            var before = MetadataValues.Read(document);
            cancellation.ThrowIfCancellationRequested();
            // Once dispatched, retain the acknowledgement even if the user
            // cancels; cancellation stops the next photo, not this response.
            await WriteMetadataAsync(address, patch.CloudFields(before), CancellationToken.None);
            patch.Apply(document);
            return MetadataValues.Read(document);
        }
        finally { _sidecarWriteGate.Release(); }
    }

    private static XmpSidecarDocument ParseEditableSidecar(string? xml) => xml == null
        ? new XmpSidecarDocument()
        : XmpParser.Parse(xml) ?? throw new IOException("Existing sidecar is invalid; no changes were written.");
}

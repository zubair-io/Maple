using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    /// <summary>Capture the active model on the UI thread before any background work.</summary>
    public Task<IReadOnlyList<ExportInput>> CaptureExportInputsAsync(CancellationToken cancellation = default)
    {
        var selected = SelectedPhotos.Count > 0 ? SelectedPhotos.ToArray()
            : SelectedPhoto is { } photo ? new[] { photo } : Array.Empty<PhotoItem>();
        var open = _openPhoto;
        var adjustments = Adjustments.Clone();
        var cloudXml = _cloudDoc == null ? null : XmpWriter.Serialize(_cloudDoc);
        var dirty = _sidecarDirty;
        var cloud = _cloud;
        var inputs = selected.Select(p => new
        {
            p.FilePath, p.EditPath, p.IsCloud, p.LocalCachePath, p.FileSizeBytes,
            Stem = Path.GetFileNameWithoutExtension(p.FileName),
            Captured = p.CaptureDate?.ToString("yyyy:MM:dd HH:mm:ss", CultureInfo.InvariantCulture),
            IsOpen = ReferenceEquals(p, open),
        }).ToArray();
        return Task.Run<IReadOnlyList<ExportInput>>(async () =>
        {
            var snapshots = new List<ExportInput>();
            foreach (var p in inputs)
            {
                cancellation.ThrowIfCancellationRequested();
                try
                {
                    var path = p.EditPath;
                    string? xml;
                    if (p.IsCloud)
                    {
                        if (p.LocalCachePath == null || !File.Exists(p.LocalCachePath))
                            path = await (cloud ?? throw new IOException("Connect to Maple Cloud to download the original."))
                                .DownloadOriginalAsync(p.FilePath, p.FileSizeBytes, null, cancellation)
                                ?? throw new IOException("Cloud original download failed. Check the connection and access permissions.");
                        xml = p.IsOpen && cloudXml != null ? cloudXml
                            : await (cloud ?? throw new IOException("Connect to Maple Cloud to capture its edits."))
                                .GetExportXmpAsync(p.FilePath, cancellation);
                    }
                    else
                    {
                        var sidecar = SidecarStore.SidecarPathFor(p.FilePath);
                        xml = File.Exists(sidecar) ? await File.ReadAllTextAsync(sidecar, cancellation) : null;
                    }
                    // Opening a cloud photo initially shows defaults while its sidecar loads.
                    // Those transient defaults must never replace a successfully fetched recipe.
                    var useActive = p.IsOpen && (!p.IsCloud || cloudXml != null || xml == null);
                    if (p.IsOpen && p.IsCloud && !useActive && dirty)
                        throw new IOException("Cloud edits were still loading when this photo was changed. Wait for its edits to load before exporting.");
                    snapshots.Add(new ExportInput(path, ExportSnapshot.Serialize(xml, useActive ? adjustments : null), p.Stem, p.Captured));
                }
                catch (Exception error) when (error is not OperationCanceledException and not OutOfMemoryException)
                { throw new IOException($"Cannot queue {p.Stem}: {error.Message}", error); }
            }
            return snapshots;
        }, cancellation);
    }

    public string[] ExportProtectedOriginals() => AllPhotos
        .Where(p => !p.IsCloud || p.LocalCachePath != null).Select(p => p.EditPath).ToArray();
}

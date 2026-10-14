using System;
using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp;

/// <summary>Session autosaves retained by photo until the filesystem accepts
/// them. A later edit replaces only that photo's pending snapshot. Metadata
/// dialogs drain these writes before reading their selection (#3878).</summary>
public sealed class PendingLocalSidecarWrites
{
    private sealed record PendingWrite(XmpSidecarDocument Document, bool DiscardBrushCorrections,
        BrushCorrectionRestoreSnapshot? RestoreBrushCorrections);

    private readonly object _gate = new();
    private readonly Dictionary<string, PendingWrite> _pending = new(StringComparer.OrdinalIgnoreCase);

    public void Stage(string path, AdjustmentState adjustments, int rating, string flag, string? label,
        bool discardBrushCorrections = false, BrushCorrectionRestoreSnapshot? restoreBrushCorrections = null)
    {
        lock (_gate) _pending[path] = new PendingWrite(new XmpSidecarDocument
        {
            Adjustments = adjustments.Clone(), Rating = rating, Flag = flag, ColorLabel = label,
        }, discardBrushCorrections, restoreBrushCorrections);
    }

    public XmpSidecarDocument? ReadPending(string path)
    {
        lock (_gate)
        {
            if (!_pending.TryGetValue(path, out var pending)) return null;
            var value = pending.Document;
            return new XmpSidecarDocument
            {
                Adjustments = value.Adjustments.Clone(), Rating = value.Rating,
                Flag = value.Flag, ColorLabel = value.ColorLabel,
            };
        }
    }

    public bool Contains(string path) { lock (_gate) return _pending.ContainsKey(path); }

    public IReadOnlyList<LocalSidecarWriteResult> Flush()
    {
        lock (_gate)
        {
            var results = new List<LocalSidecarWriteResult>();
            foreach (var (path, pending) in _pending.ToArray())
            {
                try
                {
                    var xml = SidecarStore.Update(path, doc =>
                    {
                        if (pending.DiscardBrushCorrections)
                            XmpBrushCorrections.RemovePassthroughContainers(doc);
                        else if (pending.RestoreBrushCorrections is { } restore)
                            XmpBrushCorrections.RestorePassthroughContainers(doc, restore);
                        doc.Adjustments = pending.Document.Adjustments.Clone();
                        doc.Rating = pending.Document.Rating;
                        doc.Flag = pending.Document.Flag;
                        doc.ColorLabel = pending.Document.ColorLabel;
                    });
                    _pending.Remove(path);
                    results.Add(new(path, xml, null));
                }
                catch (Exception error) { results.Add(new(path, null, error)); }
            }
            return results;
        }
    }
}

public sealed record LocalSidecarWriteResult(string Path, string? Xml, Exception? Error);

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
    private readonly object _gate = new();
    private readonly Dictionary<string, XmpSidecarDocument> _pending = new(StringComparer.OrdinalIgnoreCase);

    public void Stage(string path, AdjustmentState adjustments, int rating, string flag, string? label)
    {
        lock (_gate) _pending[path] = new XmpSidecarDocument
        {
            Adjustments = adjustments.Clone(), Rating = rating, Flag = flag, ColorLabel = label,
        };
    }

    public XmpSidecarDocument? ReadPending(string path)
    {
        lock (_gate)
        {
            if (!_pending.TryGetValue(path, out var value)) return null;
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
            foreach (var (path, snapshot) in _pending.ToArray())
            {
                try
                {
                    var xml = SidecarStore.Update(path, doc =>
                    {
                        doc.Adjustments = snapshot.Adjustments.Clone();
                        doc.Rating = snapshot.Rating;
                        doc.Flag = snapshot.Flag;
                        doc.ColorLabel = snapshot.ColorLabel;
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

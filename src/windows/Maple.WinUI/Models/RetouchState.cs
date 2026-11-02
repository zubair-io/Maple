using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.Models;

public enum RetouchKind { Heal, Clone }

// Fractions of the upright (EXIF-oriented) image, as every host stores them
// (#4473); radius is a fraction of the upright WIDTH, not height.
public sealed record RetouchSpot(RetouchKind Kind, double X, double Y,
    double SourceX, double SourceY, double Radius, double Feather = 0.5, double Opacity = 1);

public sealed record RetouchEntry(int XmlIndex, RetouchSpot Spot);

/// <summary>
/// Immutable decode-owned repair document (#3888). Keeping the complete XML
/// retains unknown spots, attributes and mask leaves when a known spot changes.
/// Sharing this value across adjustment snapshots is safe; edits replace it.
/// <see cref="IsLegacyFrame"/> marks a list read from a sidecar that predates
/// <c>papp:RetouchFrameVersion</c>: Windows stored those in the decode
/// (sensor) frame, so they are converted to the upright frame once the RAW's
/// orientation is known (#4473) and are not editable until then.
/// </summary>
public sealed class RetouchState
{
    public static RetouchState Empty { get; } = new(null, new List<RetouchEntry>());
    public string? Xml { get; }
    public IReadOnlyList<RetouchEntry> Spots { get; }
    public bool IsLegacyFrame { get; }

    internal RetouchState(string? xml, List<RetouchEntry> spots, bool isLegacyFrame = false)
    {
        Xml = xml;
        Spots = spots.AsReadOnly();
        IsLegacyFrame = isLegacyFrame && spots.Count > 0;
    }

    public RetouchState AsLegacyFrame() => Spots.Count == 0 ? this : new(Xml, Spots.ToList(), true);
}

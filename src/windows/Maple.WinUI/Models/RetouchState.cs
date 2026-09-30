using System.Collections.Generic;

namespace Maple.WinUI.Models;

public enum RetouchKind { Heal, Clone }

// Full oriented-image fractions; radius is a fraction of WIDTH, not height.
public sealed record RetouchSpot(RetouchKind Kind, double X, double Y,
    double SourceX, double SourceY, double Radius, double Feather = 0.5, double Opacity = 1);

public sealed record RetouchEntry(int XmlIndex, RetouchSpot Spot);

/// <summary>
/// Immutable decode-owned repair document (#3888). Keeping the complete XML
/// retains unknown spots, attributes and mask leaves when a known spot changes.
/// Sharing this value across adjustment snapshots is safe; edits replace it.
/// </summary>
public sealed class RetouchState
{
    public static RetouchState Empty { get; } = new(null, new List<RetouchEntry>());
    public string? Xml { get; }
    public IReadOnlyList<RetouchEntry> Spots { get; }

    internal RetouchState(string? xml, List<RetouchEntry> spots)
    {
        Xml = xml;
        Spots = spots.AsReadOnly();
    }
}

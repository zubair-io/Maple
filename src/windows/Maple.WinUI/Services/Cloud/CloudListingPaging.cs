using System;
using System.Collections.Generic;

namespace Maple.WinUI.Services.Cloud;

/// <summary>Guards for walking a cursor-paged folder listing: a server that
/// repeats a cursor or an entry must not loop the client forever or show a
/// file twice.</summary>
internal sealed class CloudListingPaging
{
    private readonly HashSet<string> _cursors = new(StringComparer.Ordinal);
    private readonly HashSet<string> _addresses = new(StringComparer.Ordinal);

    /// <summary>False when the server handed back a cursor this walk already followed.</summary>
    public bool AcceptCursor(string? cursor) => string.IsNullOrEmpty(cursor) || _cursors.Add(cursor);

    /// <summary>False for an address already listed in this walk; an entry with no address is always new.</summary>
    public bool AcceptAddress(string address) => string.IsNullOrEmpty(address) || _addresses.Add(address);

    /// <summary>Where a tile named <paramref name="name"/> goes in a list already ordered by name,
    /// after any existing tile whose name differs only in case.</summary>
    public static int InsertIndex<T>(IReadOnlyList<T> ordered, Func<T, string> nameOf, string name)
    {
        var low = 0;
        var high = ordered.Count;
        while (low < high)
        {
            var mid = (low + high) / 2;
            if (StringComparer.OrdinalIgnoreCase.Compare(nameOf(ordered[mid]), name) <= 0)
                low = mid + 1;
            else
                high = mid;
        }
        return low;
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Maple.WinUI.Services.Pano;

/// <summary>The order maple-cli sorts its input frames into, which is the
/// order a seam region's frame index counts in (#5992). The CLI sorts Rust
/// paths: network shares before drive letters, then component by component,
/// each compared as UTF-8 bytes — so `IMG_2.DNG` precedes `img_1.dng`, and
/// `a\z.dng` precedes `a-b\c.dng`.</summary>
public static class PanoFrameOrder
{
    private static readonly char[] Separators = { '\\', '/' };

    public static IReadOnlyList<string> Sort(IEnumerable<string> paths) =>
        paths.Select(path => (path, key: Key(path)))
            .OrderBy(item => item.key, Comparer<(int Rank, byte[][] Parts)>.Create(Compare))
            .Select(item => item.path)
            .ToList();

    private static (int Rank, byte[][] Parts) Key(string path)
    {
        var parts = path.Split(Separators, StringSplitOptions.RemoveEmptyEntries).Where(part => part != ".").ToArray();
        var isShare = path.Length > 1 && Separators.Contains(path[0]) && Separators.Contains(path[1]);
        var isDrive = parts.Length > 0 && parts[0].Length == 2 && parts[0][1] == ':';
        var named = isDrive ? parts.Skip(1).Prepend(parts[0].ToUpperInvariant()) : parts;
        return (isShare ? 0 : isDrive ? 1 : 2, named.Select(part => Encoding.UTF8.GetBytes(part)).ToArray());
    }

    private static int Compare((int Rank, byte[][] Parts) a, (int Rank, byte[][] Parts) b)
    {
        if (a.Rank != b.Rank)
            return a.Rank.CompareTo(b.Rank);
        var difference = a.Parts.Zip(b.Parts, (x, y) => x.AsSpan().SequenceCompareTo(y)).FirstOrDefault(order => order != 0);
        return difference != 0 ? difference : a.Parts.Length.CompareTo(b.Parts.Length);
    }
}

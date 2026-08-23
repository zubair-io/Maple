using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>
    /// The template-substitution logic behind <see cref="MuiBatchRenameModal"/>
    /// (unified-component-catalog.md §4.4, "Batch Rename" row: "Template
    /// with live preview" — this wave's brief calls for a live
    /// <c>{date}_{seq}</c> substitution). Supports four tokens: the
    /// original filename stem (<c>{name}</c>), its extension
    /// (<c>{ext}</c>), the batch's fixed date (<c>{date}</c>, ISO
    /// <c>yyyy-MM-dd</c>), and a per-item sequence number
    /// (<c>{seq}</c>, zero-padded to <paramref name="seqPadding"/> digits,
    /// starting at <paramref name="seqStart"/> and incrementing per item).
    /// Pure string substitution — unit tested without a live Window.
    /// </summary>
    public static class MuiBatchRenameLogic
    {
        public static string Apply(string template, string originalName, string extension, DateOnly date, int sequence, int seqPadding)
        {
            var seq = sequence.ToString().PadLeft(Math.Max(1, seqPadding), '0');
            return (template ?? string.Empty)
                .Replace("{name}", originalName ?? string.Empty)
                .Replace("{ext}", extension ?? string.Empty)
                .Replace("{date}", date.ToString("yyyy-MM-dd"))
                .Replace("{seq}", seq);
        }

        public static IReadOnlyList<string> PreviewBatch(
            string template, IReadOnlyList<(string Name, string Ext)> originals,
            DateOnly date, int seqStart, int seqPadding) =>
            originals
                .Select((item, i) => Apply(template, item.Name, item.Ext, date, seqStart + i, seqPadding))
                .ToList();
    }
}

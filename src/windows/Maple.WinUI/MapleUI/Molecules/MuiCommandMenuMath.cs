using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>One entry in a Command Menu's palette.</summary>
    public sealed record MuiCommandItem(string Id, string Label, string? IconName = null, string? Shortcut = null);

    /// <summary>
    /// Plain, WinUI-free filter/clamp math behind the Maple.UI Command Menu
    /// molecule (unified-component-catalog.md §2.4). Same split as
    /// <see cref="MuiSliderMath"/> — linkable into Maple.WinUI.Tests without
    /// a live Window. Ports `mui-command-menu.component.ts`'s `filtered`/
    /// `clampedActiveIndex` computed signals.
    /// </summary>
    public static class MuiCommandMenuMath
    {
        /// <summary>Case-insensitive substring filter over each command's
        /// label. An empty/whitespace query returns every command,
        /// unfiltered — matches the web computed's early return.</summary>
        public static IReadOnlyList<MuiCommandItem> Filter(IReadOnlyList<MuiCommandItem> commands, string query)
        {
            var q = (query ?? string.Empty).Trim();
            if (q.Length == 0) return commands;
            return commands.Where(c => c.Label.Contains(q, StringComparison.OrdinalIgnoreCase)).ToList();
        }

        /// <summary>Clamps an active index into [0, count-1]; -1 when
        /// count is 0 (nothing to highlight).</summary>
        public static int ClampActiveIndex(int activeIndex, int count)
        {
            if (count == 0) return -1;
            return Math.Min(Math.Max(0, activeIndex), count - 1);
        }
    }
}

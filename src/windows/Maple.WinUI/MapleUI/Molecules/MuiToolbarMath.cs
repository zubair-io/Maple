using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>One action in a Toolbar.</summary>
    public sealed record MuiToolbarItem(string Id, string IconName, string Label, bool Disabled = false);

    /// <summary>One entry in a Toolbar's list — either an action item or a
    /// divider marker (a null <see cref="Item"/>).</summary>
    public readonly record struct MuiToolbarEntry(MuiToolbarItem? Item)
    {
        public bool IsDivider => Item is null;
        public static MuiToolbarEntry Divider() => new(null);
        public static MuiToolbarEntry For(MuiToolbarItem item) => new(item);
    }

    /// <summary>The visible row plus whatever overflowed into the trailing
    /// "more" popover.</summary>
    public sealed record MuiToolbarSplit(IReadOnlyList<MuiToolbarEntry> Visible, IReadOnlyList<MuiToolbarItem> Overflow);

    /// <summary>
    /// Plain, WinUI-free overflow-split math behind the Maple.UI Toolbar
    /// molecule (unified-component-catalog.md §2.5). Same split as
    /// <see cref="MuiSliderMath"/> — linkable into Maple.WinUI.Tests without
    /// a live Window. Ports `mui-toolbar.component.ts`'s `split` computed.
    /// </summary>
    public static class MuiToolbarMath
    {
        /// <summary>Splits <paramref name="entries"/> into what fits before
        /// <paramref name="maxVisible"/> action items and what overflows.
        /// Dividers only survive into the visible list while overflow
        /// hasn't started yet — a trailing divider right at the overflow
        /// boundary is dropped from both lists (nothing to separate once
        /// everything after it moved into the popover), matching the web
        /// computed's own "only while filling the visible row" comment.</summary>
        public static MuiToolbarSplit Split(IReadOnlyList<MuiToolbarEntry> entries, int maxVisible)
        {
            var visible = new List<MuiToolbarEntry>();
            var overflow = new List<MuiToolbarItem>();
            var itemCount = 0;

            foreach (var entry in entries)
            {
                if (entry.IsDivider)
                {
                    if (overflow.Count == 0) visible.Add(entry);
                    continue;
                }

                if (itemCount < maxVisible)
                {
                    visible.Add(entry);
                    itemCount++;
                }
                else
                {
                    overflow.Add(entry.Item!);
                }
            }

            return new MuiToolbarSplit(visible, overflow);
        }
    }
}

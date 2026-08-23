using System;

namespace Maple.UI
{
    /// <summary>
    /// Plain, WinUI-free visible/overflow split math behind the Maple.UI
    /// Avatar Group molecule (unified-component-catalog.md §2.5). Same
    /// split as <see cref="MuiSliderMath"/> — linkable into
    /// Maple.WinUI.Tests without a live Window. Ports
    /// `mui-avatar-group.component.ts`'s `visible`/`overflowCount` computeds.
    /// </summary>
    public static class MuiAvatarGroupMath
    {
        /// <summary>How many of <paramref name="total"/> members render as
        /// avatars before the "+N" badge takes over. Clamped into
        /// [0, total] — a negative <paramref name="max"/> shows none.</summary>
        public static int VisibleCount(int total, int max) => Math.Min(Math.Max(0, total), Math.Max(0, max));

        /// <summary>The "+N" badge count — 0 (badge hidden) whenever the
        /// group doesn't exceed <paramref name="max"/>.</summary>
        public static int OverflowCount(int total, int max) => Math.Max(0, total - max);
    }
}

using System;

namespace Maple.UI
{
    /// <summary>
    /// Pure clamp/collapse math behind <see cref="MuiSplitLayout"/> —
    /// unit-tested without a live Window. Mirrors
    /// `mui-split-layout.component.ts`'s two-stage collapse: Detail
    /// collapses first (900px), then Sidebar (640px), leaving Center
    /// full-width on a phone.
    /// </summary>
    public static class MuiSplitLayoutMath
    {
        /// <summary>Below this host width, Detail collapses (hidden) even
        /// if <c>showDetail</c> is true — there's no room for a third
        /// column.</summary>
        public const double DetailCollapsePx = 900.0;

        /// <summary>Below this host width, Sidebar collapses too, leaving
        /// Center alone.</summary>
        public const double SidebarCollapsePx = 640.0;

        public static double Clamp(double value, double min, double max) =>
            Math.Min(max, Math.Max(min, value));

        public static bool SidebarCollapsed(double hostWidth, bool collapseEnabled) =>
            collapseEnabled && hostWidth < SidebarCollapsePx;

        public static bool DetailCollapsed(bool showDetail, double hostWidth, bool collapseEnabled) =>
            !showDetail || (collapseEnabled && hostWidth < DetailCollapsePx);
    }
}

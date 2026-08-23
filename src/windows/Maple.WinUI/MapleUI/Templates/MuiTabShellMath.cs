namespace Maple.UI
{
    /// <summary>Tab bar placement for <see cref="MuiTabShell"/>. Declared
    /// here (not in the WinUI-dependent <see cref="MuiTabShell"/> control
    /// file) so this WinUI-free enum + its placement math can be linked
    /// into Maple.WinUI.Tests without pulling in WinUI — same split as
    /// <see cref="MuiDialogResultKind"/>/<see cref="MuiDialogLogic"/>.
    /// </summary>
    public enum MuiTabShellPlacement { Auto, Top, Bottom }

    /// <summary>
    /// Pure tab-bar-placement math behind <see cref="MuiTabShell"/> —
    /// unit-tested without a live Window. Mirrors
    /// `mui-tab-shell.component.ts`'s "top on tablet/desktop, bottom on
    /// phone" container-query breakpoint.
    /// </summary>
    public static class MuiTabShellMath
    {
        /// <summary>Below this host width, an Auto placement puts the tab
        /// bar at the bottom (thumb reach).</summary>
        public const double PhoneBreakpointPx = 640.0;

        public static bool TabBarAtBottom(MuiTabShellPlacement placement, double hostWidth) => placement switch
        {
            MuiTabShellPlacement.Bottom => true,
            MuiTabShellPlacement.Top => false,
            _ => hostWidth < PhoneBreakpointPx,
        };
    }
}

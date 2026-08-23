namespace Maple.UI
{
    /// <summary>Overlay Shell panel size (unified-component-catalog.md
    /// §5, "Overlay Shell" row: "sm, md, lg, full"). Declared here (not in
    /// the WinUI-dependent <see cref="MuiOverlayShell"/> control file) so
    /// this WinUI-free enum + its size-mapping math can be linked into
    /// Maple.WinUI.Tests without pulling in WinUI — same split as
    /// <see cref="MuiDialogResultKind"/>/<see cref="MuiDialogLogic"/>.
    /// </summary>
    public enum MuiOverlayShellSize { Sm, Md, Lg, Full }

    /// <summary>
    /// Pure size → pixel-width mapping behind <see cref="MuiOverlayShell"/>
    /// — unit-tested without a live Window. Mirrors
    /// `mui-overlay-shell.component.scss`'s <c>.size-*</c> max-widths.
    /// </summary>
    public static class MuiOverlayShellMath
    {
        public static double MaxWidthFor(MuiOverlayShellSize size) => size switch
        {
            MuiOverlayShellSize.Sm => 360.0,
            MuiOverlayShellSize.Lg => 800.0,
            MuiOverlayShellSize.Full => double.PositiveInfinity,
            _ => 560.0, // Md, and the safe fallback for any future value.
        };
    }
}

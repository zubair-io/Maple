namespace Maple.WinUI
{
    /// <summary>Shell navigation follows the product's three-stage flow:
    /// Browse (grid) → Preview (full image + filmstrip rail + culling) → Edit
    /// (full-bleed canvas with the same filmstrip rail, the floating tool
    /// rail and group panels). Sliders exist only in Edit. Lives in its own
    /// WinUI-free file (rather than MainWindow.xaml.cs, which declares the
    /// state machine over it) so the mode-keyed rules in
    /// <see cref="ViewerFilmstripLogic"/> link into Maple.WinUI.Tests.</summary>
    public enum ShellMode { Browse, Preview, Edit }
}

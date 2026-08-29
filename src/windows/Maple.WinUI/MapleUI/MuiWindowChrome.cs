using Microsoft.UI.Xaml;
using Windows.UI;

namespace Maple.UI
{
    /// <summary>
    /// Custom title-bar chrome (#3079) — extends a window's content into the
    /// frame's title-bar strip the way modern Windows apps do (Terminal,
    /// Edge, File Explorer): the app claims the non-client area and supplies
    /// its own drag region, while the OS keeps overlaying the caption
    /// buttons (minimize / maximize / close plus the snap-layouts flyout)
    /// and keeps the system drag behaviors (move, double-click maximize,
    /// right-click system menu) on the region passed to
    /// <see cref="Window.SetTitleBar"/>. Caption-button colors are pinned to
    /// the Maple tokens so the overlaid buttons sit naturally on the dark
    /// chrome instead of the stock light-on-white frame treatment.
    /// </summary>
    public static class MuiWindowChrome
    {
        /// <summary>Claims the title-bar strip for <paramref name="window"/>'s
        /// content and makes <paramref name="dragRegion"/> the system drag
        /// area. The drag region must be hit-testable (a background-less
        /// panel is invisible to hit-testing — give it at least a
        /// Transparent background) and must not contain interactive
        /// controls, which would become unreachable under the drag
        /// handling.</summary>
        public static void Extend(Window window, UIElement dragRegion)
        {
            window.ExtendsContentIntoTitleBar = true;
            window.SetTitleBar(dragRegion);

            var buttons = window.AppWindow.TitleBar;
            buttons.ButtonBackgroundColor = Microsoft.UI.Colors.Transparent;
            buttons.ButtonInactiveBackgroundColor = Microsoft.UI.Colors.Transparent;
            buttons.ButtonForegroundColor = C("MapleTextMainColor");
            buttons.ButtonInactiveForegroundColor = C("MapleTextMutedColor");
            buttons.ButtonHoverBackgroundColor = C("MapleSurfaceHoverColor");
            buttons.ButtonHoverForegroundColor = C("MapleTextMainColor");
            buttons.ButtonPressedBackgroundColor = C("MapleSurfaceColor");
            buttons.ButtonPressedForegroundColor = C("MapleTextMainColor");
        }

        // Direct Color cast from the raw Maple*Color resources — routing
        // through SolidColorBrush is the TokenColor InvalidCastException
        // class MN2 fixed in MuiColorWheel/MuiLivingSlider.
        private static Color C(string key) => (Color)Application.Current.Resources[key];
    }
}

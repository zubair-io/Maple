using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.WinUI.Controls;

namespace Maple.UI.Atoms
{
    /// <summary>Icon size scale (icon.md § Tokens used): the unified guide's
    /// five-step scale in pixels — xs 14, sm 16, md 24, lg 30, xl 36.</summary>
    public enum MuiIconSize { Xs14, Sm16, Md24, Lg30, Xl36 }

    /// <summary>
    /// Maple.UI Icon atom (docs/design/maple-ui/components/icon.md) — a thin
    /// size-scale wrapper over the existing <see cref="MapleIconControl"/>
    /// glyph registry (Controls/MapleIconShapes.cs), the same stroke-icon
    /// family the app chrome already draws from. This atom does not pick a
    /// new icon set (icon.md explicitly defers that); it gives the existing
    /// registry the contract's five named sizes instead of a raw pixel Size.
    /// </summary>
    public sealed class MuiIcon : ContentControl
    {
        public static readonly DependencyProperty IconNameProperty =
            DependencyProperty.Register(nameof(IconName), typeof(string), typeof(MuiIcon),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiIcon)d).Rebuild()));

        public static readonly DependencyProperty SizeProperty =
            DependencyProperty.Register(nameof(Size), typeof(MuiIconSize), typeof(MuiIcon),
                new PropertyMetadata(MuiIconSize.Md24, (d, _) => ((MuiIcon)d).Rebuild()));

        public static readonly DependencyProperty IconColorProperty =
            DependencyProperty.Register(nameof(IconColor), typeof(Brush), typeof(MuiIcon),
                new PropertyMetadata(null, (d, _) => ((MuiIcon)d).Rebuild()));

        public string IconName
        {
            get => (string)GetValue(IconNameProperty);
            set => SetValue(IconNameProperty, value);
        }

        public MuiIconSize Size
        {
            get => (MuiIconSize)GetValue(SizeProperty);
            set => SetValue(SizeProperty, value);
        }

        /// <summary>Overrides the inherited Foreground. Null (the default)
        /// tints from currentColor, per icon.md's "Color" prop.</summary>
        public Brush? IconColor
        {
            get => (Brush?)GetValue(IconColorProperty);
            set => SetValue(IconColorProperty, value);
        }

        public MuiIcon()
        {
            IsTabStop = false;
            // Decorative by default (icon.md § Accessibility): most Icon
            // instances sit next to a labeled control, so they're hidden
            // from assistive tech unless the host explicitly needs one
            // exposed (a wrapping IconButton would set its own name instead).
            AutomationProperties.SetAccessibilityView(this, AccessibilityView.Raw);
            Rebuild();
        }

        private static double PixelSize(MuiIconSize size) => size switch
        {
            MuiIconSize.Xs14 => 14,
            MuiIconSize.Sm16 => 16,
            MuiIconSize.Md24 => 24,
            MuiIconSize.Lg30 => 30,
            MuiIconSize.Xl36 => 36,
            _ => 24,
        };

        private void Rebuild()
        {
            var brush = IconColor ?? Foreground;
            Content = string.IsNullOrEmpty(IconName)
                ? null
                : MapleIconControl.Build(IconName, PixelSize(Size), brush);
        }
    }
}

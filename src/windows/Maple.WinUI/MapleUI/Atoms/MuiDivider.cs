using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Maple.UI.Atoms
{
    /// <summary>Divider orientation (divider.md § Variants).</summary>
    public enum MuiDividerOrientation { Horizontal, Vertical }

    /// <summary>Divider emphasis (divider.md § Props).</summary>
    public enum MuiDividerEmphasis { Default, High }

    /// <summary>
    /// Maple.UI Divider atom (docs/design/maple-ui/components/divider.md) —
    /// a 1px hairline separator, purely decorative and excluded from the
    /// accessibility tree per the contract.
    /// </summary>
    public sealed class MuiDivider : ContentControl
    {
        public static readonly DependencyProperty OrientationProperty =
            DependencyProperty.Register(nameof(Orientation), typeof(MuiDividerOrientation), typeof(MuiDivider),
                new PropertyMetadata(MuiDividerOrientation.Horizontal, (d, _) => ((MuiDivider)d).Rebuild()));

        public static readonly DependencyProperty EmphasisProperty =
            DependencyProperty.Register(nameof(Emphasis), typeof(MuiDividerEmphasis), typeof(MuiDivider),
                new PropertyMetadata(MuiDividerEmphasis.Default, (d, _) => ((MuiDivider)d).Rebuild()));

        public MuiDividerOrientation Orientation
        {
            get => (MuiDividerOrientation)GetValue(OrientationProperty);
            set => SetValue(OrientationProperty, value);
        }

        public MuiDividerEmphasis Emphasis
        {
            get => (MuiDividerEmphasis)GetValue(EmphasisProperty);
            set => SetValue(EmphasisProperty, value);
        }

        private readonly Rectangle _line = new();

        public MuiDivider()
        {
            Content = _line;
            IsTabStop = false;
            // divider.md § Accessibility: purely decorative, excluded from
            // the accessibility tree.
            AutomationProperties.SetAccessibilityView(this, AccessibilityView.Raw);
            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _line.Fill = Emphasis == MuiDividerEmphasis.High ? R("MapleBorderHi") : R("MapleBorder");

            if (Orientation == MuiDividerOrientation.Vertical)
            {
                _line.Width = 1;
                _line.Height = double.NaN;
                HorizontalAlignment = HorizontalAlignment.Center;
                VerticalAlignment = VerticalAlignment.Stretch;
            }
            else
            {
                _line.Height = 1;
                _line.Width = double.NaN;
                HorizontalAlignment = HorizontalAlignment.Stretch;
                VerticalAlignment = VerticalAlignment.Center;
            }
        }
    }
}

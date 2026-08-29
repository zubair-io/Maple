using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>Progress shape (unified-component-catalog.md §1.5 Feedback,
    /// "Progress" row: "Shapes: bar, ring").</summary>
    public enum MuiProgressShape { Bar, Ring }

    /// <summary>Progress size (catalog row: "Sizes").</summary>
    public enum MuiProgressSize { Sm, Md }

    /// <summary>
    /// Maple.UI Progress atom (unified-component-catalog.md §1.5 Feedback,
    /// "Progress" row: "Determinate or indeterminate · Shapes: bar, ring ·
    /// Indeterminate animation · With/without label").
    ///
    /// Bar is a restyled <see cref="ProgressBar"/> (Foreground/Background
    /// set to Maple tokens rather than a ControlTemplate rewrite, same
    /// reasoning as every other atom's "no compiler to verify a template
    /// against" note). Ring is a <see cref="ProgressRing"/> in its native
    /// modern determinate/indeterminate mode (WinAppSDK's ProgressRing has
    /// carried Value/Minimum/Maximum/IsIndeterminate since well before the
    /// 1.6.241114003 this project pins, unlike the UWP-era
    /// indeterminate-only ProgressRing).
    /// </summary>
    public sealed class MuiProgress : ContentControl
    {
        public static readonly DependencyProperty ProgressShapeProperty =
            DependencyProperty.Register(nameof(ProgressShape), typeof(MuiProgressShape), typeof(MuiProgress),
                new PropertyMetadata(MuiProgressShape.Bar, (d, _) => ((MuiProgress)d).Rebuild()));

        public static readonly DependencyProperty ProgressSizeProperty =
            DependencyProperty.Register(nameof(ProgressSize), typeof(MuiProgressSize), typeof(MuiProgress),
                new PropertyMetadata(MuiProgressSize.Md, (d, _) => ((MuiProgress)d).Rebuild()));

        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(double), typeof(MuiProgress),
                new PropertyMetadata(0.0, (d, _) => ((MuiProgress)d).Rebuild()));

        public static readonly DependencyProperty IsIndeterminateProperty =
            DependencyProperty.Register(nameof(IsIndeterminate), typeof(bool), typeof(MuiProgress),
                new PropertyMetadata(false, (d, _) => ((MuiProgress)d).Rebuild()));

        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiProgress),
                new PropertyMetadata(null, (d, _) => ((MuiProgress)d).Rebuild()));

        public MuiProgressShape ProgressShape
        {
            get => (MuiProgressShape)GetValue(ProgressShapeProperty);
            set => SetValue(ProgressShapeProperty, value);
        }

        public MuiProgressSize ProgressSize
        {
            get => (MuiProgressSize)GetValue(ProgressSizeProperty);
            set => SetValue(ProgressSizeProperty, value);
        }

        /// <summary>0-100. Ignored while IsIndeterminate.</summary>
        public double Value
        {
            get => (double)GetValue(ValueProperty);
            set => SetValue(ValueProperty, value);
        }

        public bool IsIndeterminate
        {
            get => (bool)GetValue(IsIndeterminateProperty);
            set => SetValue(IsIndeterminateProperty, value);
        }

        /// <summary>Optional caption below the indicator. Null renders none.</summary>
        public string? Label
        {
            get => (string?)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 6 };
        private readonly ProgressBar _bar = new();
        private readonly ProgressRing _ring = new();
        private readonly TextBlock _labelText = new() { FontSize = 11 };

        public MuiProgress()
        {
            _root.Children.Add(_bar);
            _root.Children.Add(_ring);
            _root.Children.Add(_labelText);
            Content = _root;
            IsTabStop = false;
            AutomationProperties.SetAccessibilityView(this, AccessibilityView.Content);

            // #3069: ContentControl's default HorizontalContentAlignment is
            // Left, which sizes the content StackPanel to its natural width
            // — for a bar-shaped Progress that is just the caption's ~32px,
            // so a `Width = 140, Value = 62` host rendered a 62%-of-32px
            // sliver (the native bar itself was fine; UIA showed the bar
            // element at 32x9). Stretch the content so the bar fills
            // whatever width the host is given — the same ContentControl
            // default-alignment trap MuiIcon hit.
            HorizontalContentAlignment = HorizontalAlignment.Stretch;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            var isBar = ProgressShape == MuiProgressShape.Bar;

            _bar.Visibility = isBar ? Visibility.Visible : Visibility.Collapsed;
            _bar.Minimum = 0;
            _bar.Maximum = 100;
            _bar.Value = Value;
            _bar.IsIndeterminate = IsIndeterminate;
            _bar.Foreground = R("MaplePrimary");
            _bar.Background = R("MapleSurfaceAlt");
            _bar.Height = ProgressSize == MuiProgressSize.Sm ? 4 : 6;

            _ring.Visibility = isBar ? Visibility.Collapsed : Visibility.Visible;
            _ring.Minimum = 0;
            _ring.Maximum = 100;
            _ring.Value = Value;
            _ring.IsIndeterminate = IsIndeterminate;
            _ring.IsActive = true;
            _ring.Foreground = R("MaplePrimary");
            var ringSize = ProgressSize == MuiProgressSize.Sm ? 20 : 28;
            _ring.Width = ringSize;
            _ring.Height = ringSize;
            _ring.HorizontalAlignment = HorizontalAlignment.Center;

            _labelText.Text = Label ?? string.Empty;
            _labelText.Foreground = R("MapleTextMuted");
            _labelText.HorizontalAlignment = isBar ? HorizontalAlignment.Left : HorizontalAlignment.Center;
            _labelText.Visibility = string.IsNullOrEmpty(Label) ? Visibility.Collapsed : Visibility.Visible;

            if (!string.IsNullOrEmpty(Label))
                AutomationProperties.SetName(this, Label!);
        }
    }
}

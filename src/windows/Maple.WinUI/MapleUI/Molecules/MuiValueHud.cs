using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Value HUD molecule (unified-component-catalog.md §2.3,
    /// "Value HUD" row: "Center-screen scrub overlay", built from Text,
    /// Progress) — a bigger, centered overlay readout for a full-canvas
    /// gesture (as opposed to <see cref="MuiValueChip"/>'s small
    /// slider-thumb-anchored pill). Purely presentational, matching
    /// `mui-value-hud.component.ts` — showing/hiding and positioning it
    /// over the canvas during a gesture is the caller's concern.
    /// </summary>
    public sealed class MuiValueHud : ContentControl
    {
        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiValueHud),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiValueHud)d).Rebuild()));

        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(string), typeof(MuiValueHud),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiValueHud)d).Rebuild()));

        public static readonly DependencyProperty ProgressPctProperty =
            DependencyProperty.Register(nameof(ProgressPct), typeof(double?), typeof(MuiValueHud),
                new PropertyMetadata(null, (d, _) => ((MuiValueHud)d).Rebuild()));

        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        public string Value
        {
            get => (string)GetValue(ValueProperty);
            set => SetValue(ValueProperty, value);
        }

        /// <summary>[0, 100], or null to hide the progress track (e.g. an
        /// unbounded tool).</summary>
        public double? ProgressPct
        {
            get => (double?)GetValue(ProgressPctProperty);
            set => SetValue(ProgressPctProperty, value);
        }

        private readonly Border _card = new()
        {
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(24, 18, 24, 18),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly MuiText _labelText = new() { Variant = MuiTextVariant.Eyebrow, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly MuiText _valueText = new() { Variant = MuiTextVariant.SourceTitle, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly MuiProgress _progress = new() { Width = 140 };

        public MuiValueHud()
        {
            _root.Children.Add(_labelText);
            _root.Children.Add(_valueText);
            _root.Children.Add(_progress);
            _card.Child = _root;
            Content = _card;
            IsTabStop = false;
            IsHitTestVisible = false;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _card.Background = new SolidColorBrush(Windows.UI.Color.FromArgb(0xF2, 0x1C, 0x19, 0x17));
            _card.BorderBrush = R("MapleBorder");
            _card.BorderThickness = new Thickness(1);

            _labelText.Text = Label;
            _valueText.Text = Value;

            _progress.Visibility = ProgressPct.HasValue ? Visibility.Visible : Visibility.Collapsed;
            _progress.Value = ProgressPct ?? 0;

            var name = string.IsNullOrEmpty(Label) ? Value : $"{Label}: {Value}";
            AutomationProperties.SetName(this, name);
        }
    }
}

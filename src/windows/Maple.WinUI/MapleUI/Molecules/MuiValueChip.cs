using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Value Chip molecule (unified-component-catalog.md §2.3,
    /// "Value Chip" row: "Floating value readout during a drag", built from
    /// Badge, Text) — a small pill meant to float above a dragged control
    /// (e.g. a slider thumb mid-drag) showing the label and live value.
    /// Purely presentational, matching `mui-value-chip.component.ts` —
    /// positioning it against the control being dragged is the caller's
    /// concern (e.g. anchor it via a Canvas/translation the host owns).
    /// </summary>
    public sealed class MuiValueChip : ContentControl
    {
        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiValueChip),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiValueChip)d).Rebuild()));

        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(string), typeof(MuiValueChip),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiValueChip)d).Rebuild()));

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

        private readonly Border _pill = new() { CornerRadius = new CornerRadius(999), BorderThickness = new Thickness(1), Padding = new Thickness(10, 4, 10, 4) };
        private readonly StackPanel _row = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
        private readonly MuiText _labelText = new() { Variant = MuiTextVariant.ToolLabel };
        private readonly MuiBadge _valueBadge = new() { Variant = MuiBadgeVariant.Count };

        public MuiValueChip()
        {
            _row.Children.Add(_labelText);
            _row.Children.Add(_valueBadge);
            _pill.Child = _row;
            Content = _pill;
            IsTabStop = false;
            IsHitTestVisible = false;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _pill.Background = R("MapleSurface");
            _pill.BorderBrush = R("MapleBorderHi");
            _labelText.Text = Label;
            _valueBadge.Value = Value;
            _valueBadge.Label = string.IsNullOrEmpty(Label) ? Value : $"{Label} {Value}";

            AutomationProperties.SetName(this, _valueBadge.Label);
        }
    }
}

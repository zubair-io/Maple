using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Maple.UI.Atoms
{
    /// <summary>Badge variant (badge.md § Variants).</summary>
    public enum MuiBadgeVariant { Count, Signal, Rating }

    /// <summary>
    /// Maple.UI Badge atom (docs/design/maple-ui/components/badge.md) — a
    /// small, filled, non-interactive status/count indicator.
    /// </summary>
    public sealed class MuiBadge : ContentControl
    {
        public static readonly DependencyProperty VariantProperty =
            DependencyProperty.Register(nameof(Variant), typeof(MuiBadgeVariant), typeof(MuiBadge),
                new PropertyMetadata(MuiBadgeVariant.Count, (d, _) => ((MuiBadge)d).Rebuild()));

        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(string), typeof(MuiBadge),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiBadge)d).Rebuild()));

        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiBadge),
                new PropertyMetadata(null, (d, _) => ((MuiBadge)d).Rebuild()));

        public MuiBadgeVariant Variant
        {
            get => (MuiBadgeVariant)GetValue(VariantProperty);
            set => SetValue(VariantProperty, value);
        }

        /// <summary>The displayed content — a count, a rating number, or
        /// short signal text.</summary>
        public string Value
        {
            get => (string)GetValue(ValueProperty);
            set => SetValue(ValueProperty, value);
        }

        /// <summary>Accessible description when Value alone isn't
        /// self-explanatory (badge.md: e.g. "3 unread" rather than "3").
        /// Falls back to Value when unset.</summary>
        public string? Label
        {
            get => (string?)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        private readonly Border _pill = new() { CornerRadius = new CornerRadius(999) };
        private readonly TextBlock _pillText = new() { FontSize = 11, FontWeight = Microsoft.UI.Text.FontWeights.Bold };
        private readonly StackPanel _ratingRow = new() { Orientation = Orientation.Horizontal, Spacing = 4 };
        private readonly MuiIcon _star = new() { IconName = "star-filled", Size = MuiIconSize.Xs14 };
        private readonly TextBlock _ratingText = new() { FontSize = 11 };

        public MuiBadge()
        {
            _pill.Child = _pillText;
            _ratingRow.Children.Add(_star);
            _ratingRow.Children.Add(_ratingText);
            IsTabStop = false;
            AutomationProperties.SetAccessibilityView(this, Microsoft.UI.Xaml.Automation.Peers.AccessibilityView.Content);
            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _pillText.Text = Value ?? string.Empty;
            _pill.Padding = new Thickness(6, 2, 6, 2);

            switch (Variant)
            {
                case MuiBadgeVariant.Signal:
                    var warn = ((SolidColorBrush)R("MapleWarn")).Color;
                    _pill.Background = new SolidColorBrush(Color.FromArgb(0x40, warn.R, warn.G, warn.B));
                    _pill.BorderBrush = R("MapleWarn");
                    _pill.BorderThickness = new Thickness(1);
                    _pillText.Foreground = R("MapleWarn");
                    Content = _pill;
                    break;

                case MuiBadgeVariant.Rating:
                    _ratingText.Text = Value ?? string.Empty;
                    _ratingText.Visibility = string.IsNullOrEmpty(Value) ? Visibility.Collapsed : Visibility.Visible;
                    _ratingText.Foreground = R("MapleStar");
                    Content = _ratingRow;
                    break;

                default: // Count
                    _pill.Background = R("MaplePrimaryDim");
                    _pill.BorderBrush = null;
                    _pill.BorderThickness = new Thickness(0);
                    _pillText.Foreground = R("MapleTextMain");
                    Content = _pill;
                    break;
            }

            // badge.md § Accessibility: never convey meaning by color alone —
            // always expose a name, falling back to the raw Value.
            var name = Label ?? Value ?? string.Empty;
            if (!string.IsNullOrEmpty(name))
                AutomationProperties.SetName(this, name);
        }
    }
}

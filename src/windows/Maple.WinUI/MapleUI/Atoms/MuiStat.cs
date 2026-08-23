using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>Stat size (stat.md § Variants — varies by size, not a
    /// stylistic branch).</summary>
    public enum MuiStatSize { Sm, Lg }

    /// <summary>Stat delta trend direction (stat.md § Props).</summary>
    public enum MuiStatTrend { Up, Down, Flat }

    /// <summary>
    /// Maple.UI Stat atom (docs/design/maple-ui/components/stat.md) — a
    /// labeled numeric value with an optional comparison delta.
    /// </summary>
    public sealed class MuiStat : ContentControl
    {
        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(string), typeof(MuiStat),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiStat)d).Rebuild()));

        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiStat),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiStat)d).Rebuild()));

        public static readonly DependencyProperty StatSizeProperty =
            DependencyProperty.Register(nameof(StatSize), typeof(MuiStatSize), typeof(MuiStat),
                new PropertyMetadata(MuiStatSize.Lg, (d, _) => ((MuiStat)d).Rebuild()));

        public static readonly DependencyProperty DeltaProperty =
            DependencyProperty.Register(nameof(Delta), typeof(string), typeof(MuiStat),
                new PropertyMetadata(null, (d, _) => ((MuiStat)d).Rebuild()));

        public static readonly DependencyProperty TrendProperty =
            DependencyProperty.Register(nameof(Trend), typeof(MuiStatTrend?), typeof(MuiStat),
                new PropertyMetadata(null, (d, _) => ((MuiStat)d).Rebuild()));

        /// <summary>The headline figure. Required.</summary>
        public string Value
        {
            get => (string)GetValue(ValueProperty);
            set => SetValue(ValueProperty, value);
        }

        /// <summary>The caption beneath the value. Required (stat.md §
        /// Accessibility: a bare number with no caption isn't
        /// self-explanatory out of context).</summary>
        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        public MuiStatSize StatSize
        {
            get => (MuiStatSize)GetValue(StatSizeProperty);
            set => SetValue(StatSizeProperty, value);
        }

        /// <summary>Optional comparison figure (e.g. "+12"). Null renders no
        /// delta row at all.</summary>
        public string? Delta
        {
            get => (string?)GetValue(DeltaProperty);
            set => SetValue(DeltaProperty, value);
        }

        /// <summary>Pairs with Delta to color it and add a directional glyph;
        /// null still renders the delta but without trend coloring.</summary>
        public MuiStatTrend? Trend
        {
            get => (MuiStatTrend?)GetValue(TrendProperty);
            set => SetValue(TrendProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly TextBlock _valueText = new() { FontWeight = Microsoft.UI.Text.FontWeights.Bold };
        private readonly TextBlock _labelText = new();
        private readonly StackPanel _deltaRow = new() { Orientation = Orientation.Horizontal, Spacing = 4 };
        private readonly TextBlock _trendGlyph = new();
        private readonly TextBlock _deltaText = new();

        public MuiStat()
        {
            _root.Children.Add(_valueText);
            _root.Children.Add(_labelText);
            _deltaRow.Children.Add(_trendGlyph);
            _deltaRow.Children.Add(_deltaText);
            _root.Children.Add(_deltaRow);
            Content = _root;
            IsTabStop = false;
            // stat.md § Accessibility: the directional glyph is decorative —
            // the delta text's own leading sign carries the direction.
            AutomationProperties.SetAccessibilityView(_trendGlyph, AccessibilityView.Raw);
            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            var large = StatSize == MuiStatSize.Lg;

            _valueText.Text = Value;
            _valueText.FontSize = large ? 28 : 17;
            _valueText.Foreground = R("MapleTextMain");

            _labelText.Text = Label;
            _labelText.FontSize = large ? 13 : 11;
            _labelText.Foreground = R("MapleTextMuted");

            if (string.IsNullOrEmpty(Delta))
            {
                _deltaRow.Visibility = Visibility.Collapsed;
            }
            else
            {
                _deltaRow.Visibility = Visibility.Visible;
                _trendGlyph.Text = Trend switch
                {
                    MuiStatTrend.Up => "▲",
                    MuiStatTrend.Down => "▼",
                    MuiStatTrend.Flat => "–",
                    _ => string.Empty,
                };
                var color = Trend switch
                {
                    MuiStatTrend.Up => R("MapleSuccessText"),
                    MuiStatTrend.Down => R("MapleErrorText"),
                    _ => R("MapleTextMuted"),
                };
                _trendGlyph.Foreground = color;
                _trendGlyph.FontSize = large ? 13 : 11;
                _deltaText.Text = Delta;
                _deltaText.Foreground = color;
                _deltaText.FontSize = large ? 13 : 11;
            }
        }
    }
}

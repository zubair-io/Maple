using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>Action Button size (action-button.md § Props).</summary>
    public enum MuiActionButtonSize { Sm, Md }

    /// <summary>Action Button orientation (action-button.md § Variants — it
    /// varies by orientation, not a stylistic branch).</summary>
    public enum MuiActionButtonOrientation { Horizontal, Stacked }

    /// <summary>
    /// Maple.UI Action Button atom (docs/design/maple-ui/components/action-button.md)
    /// — the compact icon+label pill used in toolbars and tool docks. Built on
    /// <see cref="ToggleButton"/> rather than <see cref="Microsoft.UI.Xaml.Controls.Button"/>:
    /// the atom's "selected" state (armed tool) is a real toggle state, and
    /// ToggleButton's IsChecked already carries the toggle automation peer the
    /// contract's accessibility section asks for (exposed to assistive tech as
    /// a toggle, not conveyed by background color alone) — no need to hand-roll
    /// an aria-pressed equivalent.
    /// </summary>
    public sealed class MuiActionButton : ToggleButton
    {
        public static readonly DependencyProperty IconNameProperty =
            DependencyProperty.Register(nameof(IconName), typeof(string), typeof(MuiActionButton),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiActionButton)d).Rebuild()));

        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiActionButton),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiActionButton)d).Rebuild()));

        public static readonly DependencyProperty ButtonSizeProperty =
            DependencyProperty.Register(nameof(ButtonSize), typeof(MuiActionButtonSize), typeof(MuiActionButton),
                new PropertyMetadata(MuiActionButtonSize.Md, (d, _) => ((MuiActionButton)d).Rebuild()));

        public static readonly DependencyProperty OrientationProperty =
            DependencyProperty.Register(nameof(Orientation), typeof(MuiActionButtonOrientation), typeof(MuiActionButton),
                new PropertyMetadata(MuiActionButtonOrientation.Horizontal, (d, _) => ((MuiActionButton)d).Rebuild()));

        public string IconName
        {
            get => (string)GetValue(IconNameProperty);
            set => SetValue(IconNameProperty, value);
        }

        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        public MuiActionButtonSize ButtonSize
        {
            get => (MuiActionButtonSize)GetValue(ButtonSizeProperty);
            set => SetValue(ButtonSizeProperty, value);
        }

        public MuiActionButtonOrientation Orientation
        {
            get => (MuiActionButtonOrientation)GetValue(OrientationProperty);
            set => SetValue(OrientationProperty, value);
        }

        /// <summary>Convenience alias over the native IsChecked (bool?),
        /// matching the atom contract's "selected" prop name.</summary>
        public bool Selected
        {
            get => IsChecked == true;
            set => IsChecked = value;
        }

        private readonly StackPanel _content = new() { Spacing = 4, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly MuiIcon _icon = new();
        private readonly TextBlock _label = new() { HorizontalAlignment = HorizontalAlignment.Center, TextAlignment = TextAlignment.Center };

        private bool _isPointerOver;

        public MuiActionButton()
        {
            _content.Children.Add(_icon);
            _content.Children.Add(_label);
            Content = _content;

            Checked += (_, _) => Rebuild();
            Unchecked += (_, _) => Rebuild();
            IsEnabledChanged += (_, _) => Rebuild();
            PointerEntered += (_, _) => { _isPointerOver = true; ApplyColors(); };
            PointerExited += (_, _) => { _isPointerOver = false; ApplyColors(); };

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void ApplyColors()
        {
            var selected = IsChecked == true;
            if (selected)
            {
                Background = R("MaplePrimaryDim");
                BorderBrush = R("MaplePrimary");
                Foreground = R("MaplePrimary");
            }
            else if (_isPointerOver)
            {
                Background = R("MapleSurfaceHover");
                BorderBrush = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
                Foreground = R("MapleTextMain");
            }
            else
            {
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
                BorderBrush = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
                Foreground = R("MapleTextMuted");
            }
        }

        private void Rebuild()
        {
            Style = (Style)Application.Current.Resources["MuiActionButtonStyle"];

            _content.Orientation = Orientation == MuiActionButtonOrientation.Stacked
                ? Microsoft.UI.Xaml.Controls.Orientation.Vertical
                : Microsoft.UI.Xaml.Controls.Orientation.Horizontal;

            var iconSize = ButtonSize == MuiActionButtonSize.Sm ? MuiIconSize.Sm16 : MuiIconSize.Md24;
            _icon.IconName = IconName;
            _icon.Size = iconSize;

            _label.Text = Label;
            _label.FontSize = ButtonSize == MuiActionButtonSize.Sm ? 10 : 11;
            _label.FontWeight = Microsoft.UI.Text.FontWeights.Bold;

            Padding = ButtonSize == MuiActionButtonSize.Sm ? new Thickness(6, 3, 6, 3) : new Thickness(8, 4, 8, 4);

            ApplyColors();

            // action-button.md § States, Disabled: opacity-only signal, same
            // rule as Button.
            Opacity = IsEnabled ? 1.0 : 0.45;

            // Default the automation name to the label, but never clobber a
            // name the consumer set explicitly (e.g. XAML's
            // AutomationProperties.Name="Color HSL tab"): Rebuild re-runs on
            // every Checked/Unchecked toggle, so an unconditional SetName
            // would silently overwrite it on first interaction. We own the
            // name only while it is empty or the value we last auto-set.
            var currentName = AutomationProperties.GetName(this);
            var ownsName = string.IsNullOrEmpty(currentName) || currentName == _autoName;
            if (!string.IsNullOrEmpty(Label) && ownsName)
            {
                AutomationProperties.SetName(this, Label);
                _autoName = Label;
            }
        }

        private string? _autoName;
    }
}

using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>Button variant (button.md § Variants).</summary>
    public enum MuiButtonVariant { Primary, Secondary, Ghost, Destructive }

    /// <summary>Button size (button.md § Props: size). No sm/lg pixel values
    /// are specified in the contract beyond the md workhorse default
    /// (radius.md, spacing.sm/md) — sm/lg step evenly off that baseline.</summary>
    public enum MuiButtonSize { Sm, Md, Lg }

    /// <summary>
    /// Maple.UI Button atom (docs/design/maple-ui/components/button.md) — the
    /// primary interactive control for committing an action. A thin styled
    /// wrapper around the native <see cref="Button"/> rather than a
    /// hand-rolled hit-target, so keyboard activation (Enter/Space), focus
    /// visuals, and tab-order exclusion when disabled all come from the
    /// platform for free instead of being reimplemented here.
    ///
    /// Hover/pressed recoloring is done by setting Background/BorderBrush as
    /// local values from Pointer event handlers (below) rather than through
    /// the base Style — a directly-assigned local value always outranks
    /// whatever the built-in ControlTemplate's PointerOver/Pressed
    /// VisualStates would otherwise apply to the same property, which is the
    /// only way to land our own `color.surface_hover` token instead of the
    /// default Fluent theme's hover brush without rewriting the control
    /// template (out of scope for a first wave with no local compiler to
    /// verify a template rewrite against).
    /// </summary>
    public sealed class MuiButton : Button
    {
        public static readonly DependencyProperty VariantProperty =
            DependencyProperty.Register(nameof(Variant), typeof(MuiButtonVariant), typeof(MuiButton),
                new PropertyMetadata(MuiButtonVariant.Secondary, (d, _) => ((MuiButton)d).Rebuild()));

        public static readonly DependencyProperty ButtonSizeProperty =
            DependencyProperty.Register(nameof(ButtonSize), typeof(MuiButtonSize), typeof(MuiButton),
                new PropertyMetadata(MuiButtonSize.Md, (d, _) => ((MuiButton)d).Rebuild()));

        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiButton),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiButton)d).Rebuild()));

        public static readonly DependencyProperty IconNameProperty =
            DependencyProperty.Register(nameof(IconName), typeof(string), typeof(MuiButton),
                new PropertyMetadata(null, (d, _) => ((MuiButton)d).Rebuild()));

        public static readonly DependencyProperty IsLoadingProperty =
            DependencyProperty.Register(nameof(IsLoading), typeof(bool), typeof(MuiButton),
                new PropertyMetadata(false, (d, _) => ((MuiButton)d).Rebuild()));

        public static readonly DependencyProperty IconColorProperty =
            DependencyProperty.Register(nameof(IconColor), typeof(Brush), typeof(MuiButton),
                new PropertyMetadata(null, (d, _) => ((MuiButton)d).Rebuild()));

        public MuiButtonVariant Variant
        {
            get => (MuiButtonVariant)GetValue(VariantProperty);
            set => SetValue(VariantProperty, value);
        }

        public MuiButtonSize ButtonSize
        {
            get => (MuiButtonSize)GetValue(ButtonSizeProperty);
            set => SetValue(ButtonSizeProperty, value);
        }

        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        /// <summary>Leading icon glyph name (see MuiIcon / MapleIconShapes).
        /// Null (the default) renders no icon.</summary>
        public string? IconName
        {
            get => (string?)GetValue(IconNameProperty);
            set => SetValue(IconNameProperty, value);
        }

        public bool IsLoading
        {
            get => (bool)GetValue(IsLoadingProperty);
            set => SetValue(IsLoadingProperty, value);
        }

        /// <summary>Overrides the leading icon's color independent of the
        /// variant-driven Foreground (e.g. a semantic green/red glyph on an
        /// otherwise Ghost/Secondary button — the pick/reject flags in the
        /// Preview pill). Null (the default) leaves the icon inheriting
        /// Foreground, matching every existing MuiButton call site.</summary>
        public Brush? IconColor
        {
            get => (Brush?)GetValue(IconColorProperty);
            set => SetValue(IconColorProperty, value);
        }

        private readonly StackPanel _content = new()
        {
            Orientation = Orientation.Horizontal,
            Spacing = 6,
        };
        private readonly MuiIcon _icon = new() { Size = MuiIconSize.Sm16 };
        private readonly TextBlock _label = new() { VerticalAlignment = VerticalAlignment.Center };
        private readonly ProgressRing _spinner = new()
        {
            Width = 16,
            Height = 16,
            IsActive = false,
            Visibility = Visibility.Collapsed,
        };

        private bool _isPointerOver;
        private bool _isPressed;

        // See the IsLoading/IsEnabled interplay comment at the tail of
        // Rebuild() for why these exist: we force the platform IsEnabled
        // off while loading (the only thing that blocks keyboard and
        // UI-Automation invocation, not just pointer clicks), so we need
        // somewhere to remember what the caller actually asked for and a
        // way to tell "the caller toggled IsEnabled" apart from "Rebuild
        // just forced it".
        private bool _desiredEnabled = true;
        private bool _suppressEnabledChanged;

        public MuiButton()
        {
            _content.Children.Add(_icon);
            _content.Children.Add(_spinner);
            _content.Children.Add(_label);
            Content = _content;

            IsEnabledChanged += (_, _) =>
            {
                if (_suppressEnabledChanged)
                    return;
                _desiredEnabled = IsEnabled;
                Rebuild();
            };
            PointerEntered += (_, _) => { _isPointerOver = true; ApplyColors(); };
            PointerExited += (_, _) => { _isPointerOver = false; _isPressed = false; ApplyColors(); };
            PointerPressed += (_, _) => { _isPressed = true; ApplyColors(); };
            PointerReleased += (_, _) => { _isPressed = false; ApplyColors(); };

            Rebuild();
        }

        private static string StyleKey(MuiButtonVariant variant) => variant switch
        {
            MuiButtonVariant.Primary => "MuiButtonPrimaryStyle",
            MuiButtonVariant.Ghost => "MuiButtonGhostStyle",
            MuiButtonVariant.Destructive => "MuiButtonDestructiveStyle",
            _ => "MuiButtonSecondaryStyle",
        };

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        /// <summary>Rest/hover/pressed (Background, BorderBrush) per variant.
        /// Primary/Destructive have no distinct hover/pressed token in
        /// ui_tokens.rs yet (button.md flags this as a follow-up token gap)
        /// — they render flat rather than guessing an un-tokenized hex.
        /// Secondary/Ghost do have a real token (`surface_hover`) and use it.</summary>
        private (Brush Bg, Brush Border) ColorsFor(MuiButtonVariant variant, bool hoverOrPressed) => variant switch
        {
            MuiButtonVariant.Primary => (R("MaplePrimary"), R("MaplePrimary")),
            MuiButtonVariant.Destructive => (R("MapleErrorBg"), R("MapleErrorText")),
            MuiButtonVariant.Ghost => hoverOrPressed
                ? (R("MapleSurfaceHover"), R("MapleSurfaceHover"))
                : (new SolidColorBrush(Microsoft.UI.Colors.Transparent), new SolidColorBrush(Microsoft.UI.Colors.Transparent)),
            _ => hoverOrPressed
                ? (R("MapleSurfaceHover"), R("MapleBorder"))
                : (R("MapleSurface"), R("MapleBorder")),
        };

        private void ApplyColors()
        {
            var (bg, border) = ColorsFor(Variant, _isPointerOver || _isPressed);
            Background = bg;
            BorderBrush = border;
            Foreground = Variant switch
            {
                MuiButtonVariant.Destructive => R("MapleErrorText"),
                _ => R("MapleTextMain"),
            };
        }

        private void Rebuild()
        {
            Style = (Style)Application.Current.Resources[StyleKey(Variant)];
            ApplyColors();

            (Padding, FontSize, MinHeight) = ButtonSize switch
            {
                MuiButtonSize.Sm => (new Thickness(8, 4, 8, 4), 11.0, 28.0),
                MuiButtonSize.Lg => (new Thickness(24, 12, 24, 12), 15.0, 44.0),
                _ => (new Thickness(16, 8, 16, 8), 13.0, 36.0),
            };

            var hasIcon = !string.IsNullOrEmpty(IconName);
            _icon.IconName = IconName ?? string.Empty;
            _icon.IconColor = IconColor;
            _icon.Visibility = hasIcon && !IsLoading ? Visibility.Visible : Visibility.Collapsed;

            _spinner.IsActive = IsLoading;
            _spinner.Visibility = IsLoading ? Visibility.Visible : Visibility.Collapsed;

            _label.Text = Label;
            _label.Visibility = string.IsNullOrEmpty(Label) ? Visibility.Collapsed : Visibility.Visible;
            _label.FontSize = FontSize;

            // button.md § States, Loading: a loading button must be
            // impossible to invoke a second time, not merely un-clickable.
            // IsHitTestVisible (below) only stops pointer clicks — keyboard
            // activation (Space/Enter) and UI-Automation's Invoke pattern
            // both bypass hit-testing and call straight into the platform
            // Button's own invoke path, so the only thing that reliably
            // blocks all three input paths at once is the control's real
            // IsEnabled. We force IsEnabled off for the duration of
            // IsLoading and restore the caller's real value once loading
            // ends: _desiredEnabled remembers what the caller last set
            // IsEnabled to (updated from IsEnabledChanged, above), and
            // _suppressEnabledChanged stops the forced write below from
            // being mistaken for a fresh caller toggle — without it, the
            // IsEnabledChanged handler would overwrite _desiredEnabled with
            // `false` on our own write and permanently forget the
            // pre-loading value.
            var effectiveEnabled = _desiredEnabled && !IsLoading;
            if (IsEnabled != effectiveEnabled)
            {
                _suppressEnabledChanged = true;
                IsEnabled = effectiveEnabled;
                _suppressEnabledChanged = false;
            }

            // button.md § States, Disabled: "40-50% opacity ... Never a
            // separate greyed-out fill color — opacity is the only disabled
            // signal." A loading button isn't "disabled" in that sense —
            // it's still on, just temporarily non-invocable — so it keeps
            // full opacity even though IsEnabled is forced false underneath
            // it while loading. The fade is keyed off _desiredEnabled (the
            // caller's real intent), not the live IsEnabled value, which
            // Loading may have overridden.
            Opacity = _desiredEnabled ? 1.0 : 0.45;
            IsHitTestVisible = effectiveEnabled;

            if (!string.IsNullOrEmpty(Label))
                AutomationProperties.SetName(this, Label);
        }
    }
}

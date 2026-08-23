using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>Input variant (unified-component-catalog.md §1.3 Form
    /// controls, Input row + docs/design/maple-ui/components/input.md §
    /// Variants). Numeric extends that contract's Default/Search pair with
    /// the catalog's own "numeric variant with steppers" requirement.</summary>
    public enum MuiInputVariant { Default, Search, Numeric }

    /// <summary>Input size (catalog row: "Sizes: sm, md"). No pixel values
    /// are specified beyond input.md's md workhorse default (radius.md,
    /// spacing.sm/md) — sm steps down from that baseline the same way
    /// MuiButton's Sm/Lg do off Button's own md default.</summary>
    public enum MuiInputSize { Sm, Md }

    /// <summary>
    /// Maple.UI Input atom (docs/design/maple-ui/components/input.md +
    /// unified-component-catalog.md §1.3) — a single-line text field.
    ///
    /// Composed from a plain <see cref="TextBox"/> (Default/Search) or
    /// <see cref="NumberBox"/> (Numeric, which gets built-in increment/
    /// decrement steppers for free via SpinButtonPlacementMode) with its own
    /// chrome turned OFF (Background transparent, BorderThickness 0) — the
    /// same reasoning MuiButton's doc comment gives for local-value color
    /// overrides: this project can't compile-verify a ControlTemplate
    /// rewrite in this worktree, so instead of fighting the native
    /// TextBox/NumberBox template for `color.input_bg`/`color.border`, an
    /// outer Border owns 100% of the visible chrome and the inner control
    /// only handles text editing.
    ///
    /// KNOWN GAP: input.md's "Filled" state (`color.text_main` value vs.
    /// `color.text_muted` placeholder) relies on the native
    /// TextBox/NumberBox placeholder-vs-value color split, which this wave
    /// leaves at its Fluent default rather than guessing at an uncertain
    /// `PlaceholderForeground`-shaped API with no compiler to check it
    /// against.
    /// </summary>
    public sealed class MuiInput : ContentControl
    {
        public static readonly DependencyProperty VariantProperty =
            DependencyProperty.Register(nameof(Variant), typeof(MuiInputVariant), typeof(MuiInput),
                new PropertyMetadata(MuiInputVariant.Default, (d, _) => ((MuiInput)d).Rebuild()));

        public static readonly DependencyProperty InputSizeProperty =
            DependencyProperty.Register(nameof(InputSize), typeof(MuiInputSize), typeof(MuiInput),
                new PropertyMetadata(MuiInputSize.Md, (d, _) => ((MuiInput)d).Rebuild()));

        public static readonly DependencyProperty TextProperty =
            DependencyProperty.Register(nameof(Text), typeof(string), typeof(MuiInput),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiInput)d).OnTextPropertyChanged((string)e.NewValue)));

        public static readonly DependencyProperty PlaceholderProperty =
            DependencyProperty.Register(nameof(Placeholder), typeof(string), typeof(MuiInput),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiInput)d).Rebuild()));

        public static readonly DependencyProperty ReadOnlyProperty =
            DependencyProperty.Register(nameof(ReadOnly), typeof(bool), typeof(MuiInput),
                new PropertyMetadata(false, (d, _) => ((MuiInput)d).Rebuild()));

        public static readonly DependencyProperty ErrorProperty =
            DependencyProperty.Register(nameof(Error), typeof(string), typeof(MuiInput),
                new PropertyMetadata(null, (d, _) => ((MuiInput)d).Rebuild()));

        public static readonly DependencyProperty PrefixIconNameProperty =
            DependencyProperty.Register(nameof(PrefixIconName), typeof(string), typeof(MuiInput),
                new PropertyMetadata(null, (d, _) => ((MuiInput)d).Rebuild()));

        public static readonly DependencyProperty SuffixIconNameProperty =
            DependencyProperty.Register(nameof(SuffixIconName), typeof(string), typeof(MuiInput),
                new PropertyMetadata(null, (d, _) => ((MuiInput)d).Rebuild()));

        public static readonly DependencyProperty AccessibleLabelProperty =
            DependencyProperty.Register(nameof(AccessibleLabel), typeof(string), typeof(MuiInput),
                new PropertyMetadata(null, (d, _) => ((MuiInput)d).Rebuild()));

        public static readonly DependencyProperty NumericValueProperty =
            DependencyProperty.Register(nameof(NumericValue), typeof(double), typeof(MuiInput),
                new PropertyMetadata(0.0, (d, e) => ((MuiInput)d).OnNumericValuePropertyChanged((double)e.NewValue)));

        public static readonly DependencyProperty MinimumProperty =
            DependencyProperty.Register(nameof(Minimum), typeof(double), typeof(MuiInput),
                new PropertyMetadata(double.NegativeInfinity, (d, _) => ((MuiInput)d).Rebuild()));

        public static readonly DependencyProperty MaximumProperty =
            DependencyProperty.Register(nameof(Maximum), typeof(double), typeof(MuiInput),
                new PropertyMetadata(double.PositiveInfinity, (d, _) => ((MuiInput)d).Rebuild()));

        public static readonly DependencyProperty SmallChangeProperty =
            DependencyProperty.Register(nameof(SmallChange), typeof(double), typeof(MuiInput),
                new PropertyMetadata(1.0, (d, _) => ((MuiInput)d).Rebuild()));

        public MuiInputVariant Variant
        {
            get => (MuiInputVariant)GetValue(VariantProperty);
            set => SetValue(VariantProperty, value);
        }

        public MuiInputSize InputSize
        {
            get => (MuiInputSize)GetValue(InputSizeProperty);
            set => SetValue(InputSizeProperty, value);
        }

        /// <summary>Two-way bound text value for Default/Search variants.
        /// Ignored for Numeric — use <see cref="NumericValue"/> there.</summary>
        public string Text
        {
            get => (string)GetValue(TextProperty);
            set => SetValue(TextProperty, value);
        }

        public string Placeholder
        {
            get => (string)GetValue(PlaceholderProperty);
            set => SetValue(PlaceholderProperty, value);
        }

        public bool ReadOnly
        {
            get => (bool)GetValue(ReadOnlyProperty);
            set => SetValue(ReadOnlyProperty, value);
        }

        /// <summary>Non-null triggers the Error state; the string itself
        /// renders as helper text below the field (input.md § Props).</summary>
        public string? Error
        {
            get => (string?)GetValue(ErrorProperty);
            set => SetValue(ErrorProperty, value);
        }

        /// <summary>Overrides the Search variant's default "search" glyph;
        /// unset on Default renders no prefix icon.</summary>
        public string? PrefixIconName
        {
            get => (string?)GetValue(PrefixIconNameProperty);
            set => SetValue(PrefixIconNameProperty, value);
        }

        /// <summary>A trailing icon-button distinct from the built-in clear
        /// ("×") affordance — e.g. a password-reveal eye. Null renders none.</summary>
        public string? SuffixIconName
        {
            get => (string?)GetValue(SuffixIconNameProperty);
            set => SetValue(SuffixIconNameProperty, value);
        }

        /// <summary>input.md § Accessibility: placeholder is never the only
        /// label. Set this (or provide a visible external label) so the
        /// field has a real accessible name once a value replaces the
        /// placeholder text.</summary>
        public string? AccessibleLabel
        {
            get => (string?)GetValue(AccessibleLabelProperty);
            set => SetValue(AccessibleLabelProperty, value);
        }

        public double NumericValue
        {
            get => (double)GetValue(NumericValueProperty);
            set => SetValue(NumericValueProperty, value);
        }

        public double Minimum
        {
            get => (double)GetValue(MinimumProperty);
            set => SetValue(MinimumProperty, value);
        }

        public double Maximum
        {
            get => (double)GetValue(MaximumProperty);
            set => SetValue(MaximumProperty, value);
        }

        public double SmallChange
        {
            get => (double)GetValue(SmallChangeProperty);
            set => SetValue(SmallChangeProperty, value);
        }

        /// <summary>Raised on every keystroke (Default/Search) — mirrors
        /// input.md's platform-native onChange.</summary>
        public event EventHandler<string>? TextChanged;

        /// <summary>Raised on Enter/blur — mirrors input.md's onCommit.</summary>
        public event EventHandler<string>? Committed;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 4 };
        private readonly Border _fieldBorder = new();
        private readonly StackPanel _fieldRow = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
        private readonly MuiIcon _prefixIcon = new() { Size = MuiIconSize.Sm16 };
        private readonly TextBox _textBox = new() { Background = Transparent(), BorderThickness = new Thickness(0) };
        private readonly NumberBox _numberBox = new()
        {
            Background = Transparent(),
            BorderThickness = new Thickness(0),
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Inline,
        };
        private readonly Button _suffixButton = GhostIconButton();
        private readonly MuiIcon _suffixIcon = new() { Size = MuiIconSize.Sm16 };
        private readonly Button _clearButton = GhostIconButton();
        private readonly TextBlock _helperText = new() { FontSize = 11, TextWrapping = TextWrapping.Wrap };

        private bool _isFocused;
        private bool _suppressTextCallback;
        private bool _suppressNumericCallback;

        public MuiInput()
        {
            _fieldBorder.Child = _fieldRow;
            _root.Children.Add(_fieldBorder);
            _root.Children.Add(_helperText);
            Content = _root;
            IsTabStop = false;

            _textBox.TextChanged += (_, _) =>
            {
                if (_suppressTextCallback) return;
                SetValue(TextProperty, _textBox.Text); // triggers OnTextPropertyChanged -> Rebuild()
                TextChanged?.Invoke(this, _textBox.Text);
            };
            _textBox.GotFocus += (_, _) => { _isFocused = true; ApplyColors(); };
            _textBox.LostFocus += (_, _) => { _isFocused = false; ApplyColors(); Committed?.Invoke(this, _textBox.Text); };
            _textBox.KeyDown += (_, e) => { if (e.Key == Windows.System.VirtualKey.Enter) Committed?.Invoke(this, _textBox.Text); };

            _numberBox.ValueChanged += (_, e) =>
            {
                if (_suppressNumericCallback || double.IsNaN(e.NewValue)) return;
                SetValue(NumericValueProperty, e.NewValue);
            };
            _numberBox.GotFocus += (_, _) => { _isFocused = true; ApplyColors(); };
            _numberBox.LostFocus += (_, _) => { _isFocused = false; ApplyColors(); Committed?.Invoke(this, _numberBox.Value.ToString()); };

            _clearButton.Content = new MuiIcon { IconName = "x", Size = MuiIconSize.Sm16 };
            _clearButton.Click += (_, _) => { Text = string.Empty; _textBox.Focus(FocusState.Programmatic); };

            _suffixButton.Content = _suffixIcon;
            _suffixButton.Click += (_, _) => SuffixActionRequested?.Invoke(this, EventArgs.Empty);

            IsEnabledChanged += (_, _) => Rebuild();
            Rebuild();
        }

        /// <summary>Raised when the suffix icon-button (not the clear
        /// button) is pressed.</summary>
        public event EventHandler? SuffixActionRequested;

        private static SolidColorBrush Transparent() => new(Microsoft.UI.Colors.Transparent);

        private static Button GhostIconButton() => new()
        {
            Background = Transparent(),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(4),
            MinWidth = 0,
            MinHeight = 0,
        };

        private void OnTextPropertyChanged(string value)
        {
            if (_textBox.Text == value) { Rebuild(); return; }
            _suppressTextCallback = true;
            _textBox.Text = value ?? string.Empty;
            _suppressTextCallback = false;
            Rebuild();
        }

        private void OnNumericValuePropertyChanged(double value)
        {
            if (_numberBox.Value.Equals(value)) { Rebuild(); return; }
            _suppressNumericCallback = true;
            _numberBox.Value = value;
            _suppressNumericCallback = false;
            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void ApplyColors()
        {
            var hasError = !string.IsNullOrEmpty(Error);
            _fieldBorder.BorderBrush = hasError
                ? R("MapleErrorText")
                : _isFocused ? R("MaplePrimary") : R("MapleBorder");
            _fieldBorder.BorderThickness = new Thickness(1);
            _fieldBorder.Background = R("MapleInputBg");
            _textBox.Foreground = R("MapleTextMain");
            _numberBox.Foreground = R("MapleTextMain");
            _helperText.Foreground = hasError ? R("MapleErrorText") : R("MapleTextMuted");
        }

        private void Rebuild()
        {
            var large = InputSize == MuiInputSize.Md;
            _fieldBorder.CornerRadius = new CornerRadius(8);
            _fieldBorder.Padding = large ? new Thickness(16, 8, 12, 8) : new Thickness(12, 4, 8, 4);
            _textBox.FontSize = large ? 13 : 12;
            _numberBox.FontSize = large ? 13 : 12;
            _textBox.MinHeight = large ? 20 : 16;

            _fieldRow.Children.Clear();

            var effectivePrefix = PrefixIconName ?? (Variant == MuiInputVariant.Search ? "search" : null);
            _prefixIcon.Visibility = string.IsNullOrEmpty(effectivePrefix) ? Visibility.Collapsed : Visibility.Visible;
            if (!string.IsNullOrEmpty(effectivePrefix))
            {
                _prefixIcon.IconName = effectivePrefix;
                _fieldRow.Children.Add(_prefixIcon);
            }

            if (Variant == MuiInputVariant.Numeric)
            {
                _numberBox.PlaceholderText = Placeholder ?? string.Empty;
                _numberBox.Minimum = Minimum;
                _numberBox.Maximum = Maximum;
                _numberBox.SmallChange = SmallChange;
                // NumberBox has no IsReadOnly-equivalent this wave can
                // verify without a compiler — ReadOnly on Numeric falls
                // back to fully disabling the steppers/entry instead of a
                // distinct read-only look (documented narrowing, not a
                // silent gap).
                _numberBox.IsEnabled = IsEnabled && !ReadOnly;
                _fieldRow.Children.Add(_numberBox);
            }
            else
            {
                _textBox.PlaceholderText = Placeholder ?? string.Empty;
                _textBox.IsReadOnly = ReadOnly;
                _textBox.IsTabStop = true;
                _fieldRow.Children.Add(_textBox);

                var showClear = !ReadOnly && IsEnabled && !string.IsNullOrEmpty(_textBox.Text);
                if (showClear)
                    _fieldRow.Children.Add(_clearButton);
            }

            if (!string.IsNullOrEmpty(SuffixIconName))
            {
                _suffixIcon.IconName = SuffixIconName;
                _fieldRow.Children.Add(_suffixButton);
            }

            _helperText.Text = Error ?? string.Empty;
            _helperText.Visibility = string.IsNullOrEmpty(Error) ? Visibility.Collapsed : Visibility.Visible;

            ApplyColors();

            // input.md § States, Disabled: 40-50% opacity, matching Button.
            Opacity = IsEnabled ? (ReadOnly ? 0.75 : 1.0) : 0.45;

            if (!string.IsNullOrEmpty(AccessibleLabel))
                AutomationProperties.SetName(Variant == MuiInputVariant.Numeric ? _numberBox : _textBox, AccessibleLabel!);
        }
    }
}

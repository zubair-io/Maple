using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Form Field molecule (unified-component-catalog.md §2.1,
    /// "Form Field" row: "Label + control + help/error", built from
    /// Text, Input, Text) — a labeled wrapper around any single control
    /// (typically a <see cref="MuiInput"/>, but any UIElement is accepted so
    /// this molecule also fronts a MuiSlider, a MuiSegmentedToggle, etc.),
    /// with an optional help caption or error message beneath.
    ///
    /// Mirrors `mui-form-field.component.ts`'s Default/Search/Numeric
    /// variant shape, but takes the control slot as a plain
    /// <see cref="ControlContent"/> UIElement rather than re-exposing every
    /// MuiInput property on this wrapper — the web molecule owns its own
    /// MuiInput instance directly, but this control composes an arbitrary
    /// already-built control per the catalog's "control-slot" framing
    /// instead of duplicating MuiInput's whole property surface a second
    /// time here.
    /// </summary>
    public sealed class MuiFormField : ContentControl
    {
        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiFormField),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiFormField)d).Rebuild()));

        public static readonly DependencyProperty ControlContentProperty =
            DependencyProperty.Register(nameof(ControlContent), typeof(UIElement), typeof(MuiFormField),
                new PropertyMetadata(null, (d, _) => ((MuiFormField)d).Rebuild()));

        public static readonly DependencyProperty HelpProperty =
            DependencyProperty.Register(nameof(Help), typeof(string), typeof(MuiFormField),
                new PropertyMetadata(null, (d, _) => ((MuiFormField)d).Rebuild()));

        public static readonly DependencyProperty ErrorProperty =
            DependencyProperty.Register(nameof(Error), typeof(string), typeof(MuiFormField),
                new PropertyMetadata(null, (d, _) => ((MuiFormField)d).Rebuild()));

        public static readonly DependencyProperty RequiredProperty =
            DependencyProperty.Register(nameof(Required), typeof(bool), typeof(MuiFormField),
                new PropertyMetadata(false, (d, _) => ((MuiFormField)d).Rebuild()));

        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        /// <summary>The control slot — typically a MuiInput, but any
        /// UIElement is accepted.</summary>
        public UIElement? ControlContent
        {
            get => (UIElement?)GetValue(ControlContentProperty);
            set => SetValue(ControlContentProperty, value);
        }

        /// <summary>Ignored while <see cref="Error"/> is set — the two are
        /// mutually exclusive, error wins (form-field.md-equivalent
        /// convention shared with MuiInput's own Error prop).</summary>
        public string? Help
        {
            get => (string?)GetValue(HelpProperty);
            set => SetValue(HelpProperty, value);
        }

        public string? Error
        {
            get => (string?)GetValue(ErrorProperty);
            set => SetValue(ErrorProperty, value);
        }

        /// <summary>Appends a required-field marker to the label.</summary>
        public bool Required
        {
            get => (bool)GetValue(RequiredProperty);
            set => SetValue(RequiredProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 6 };
        private readonly StackPanel _labelRow = new() { Orientation = Orientation.Horizontal, Spacing = 2 };
        private readonly MuiText _labelText = new() { Variant = MuiTextVariant.RowLabel };
        private readonly MuiText _requiredMark = new() { Variant = MuiTextVariant.RowLabel, ColorRole = MuiTextColorRole.Error, Text = "*" };
        private readonly ContentPresenter _controlHost = new();
        private readonly MuiText _footnote = new() { Variant = MuiTextVariant.ToolLabel };

        public MuiFormField()
        {
            _labelRow.Children.Add(_labelText);
            _labelRow.Children.Add(_requiredMark);
            _root.Children.Add(_labelRow);
            _root.Children.Add(_controlHost);
            _root.Children.Add(_footnote);
            Content = _root;
            IsTabStop = false;
            IsEnabledChanged += (_, _) => Rebuild();
            Rebuild();
        }

        private void Rebuild()
        {
            _labelText.Text = Label;
            _requiredMark.Visibility = Required ? Visibility.Visible : Visibility.Collapsed;

            _controlHost.Content = ControlContent;

            var hasError = !string.IsNullOrEmpty(Error);
            _footnote.Text = hasError ? Error! : Help ?? string.Empty;
            _footnote.ColorRole = hasError ? MuiTextColorRole.Error : MuiTextColorRole.Muted;
            _footnote.Visibility = string.IsNullOrEmpty(_footnote.Text) ? Visibility.Collapsed : Visibility.Visible;

            // form-field.md-equivalent Disabled: 40-50% opacity, matching
            // every other atom/molecule in this library.
            Opacity = IsEnabled ? 1.0 : 0.45;

            if (!string.IsNullOrEmpty(Label))
                AutomationProperties.SetName(this, Label);
        }
    }
}

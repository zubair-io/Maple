using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI.Atoms
{
    /// <summary>
    /// Maple.UI Checkbox atom (docs/design/maple-ui/components/checkbox.md)
    /// — a binary or tri-state selection control for lists of independent
    /// options. Built directly on <see cref="CheckBox"/> rather than a
    /// hand-rolled box+glyph, per the contract's explicit accessibility
    /// requirement: "never a bare styled &lt;div&gt; with a click handler".
    /// `IsThreeState` is always on, so the native
    /// <see cref="CheckBox.IsChecked"/> (bool?) carries Indeterminate (null)
    /// through the platform's own mixed-state automation API instead of a
    /// purely-visual dash the contract explicitly forbids.
    ///
    /// The checked/indeterminate glyph is recolored to `color.primary` via
    /// per-control lightweight-styling theme-brush overrides (#3069 — the
    /// Fluent default painted it in the OS accent color, diverging from the
    /// web checkbox's Maple-red fill). KNOWN GAP: the box corner radius
    /// stays at its Fluent default rather than `radius.xs` — that one still
    /// needs the ControlTemplate rewrite MuiStyles.xaml's header rules out.
    /// </summary>
    public sealed class MuiCheckbox : CheckBox
    {
        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiCheckbox),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiCheckbox)d).Rebuild()));

        /// <summary>checkbox.md § Props: checkboxes are almost always
        /// labeled; an unlabeled one needs the same explicit
        /// accessible-label treatment as an icon-only Button.</summary>
        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        /// <summary>Convenience alias over the native IsChecked (bool?),
        /// matching checkbox.md's `checked: true | false | 'indeterminate'`
        /// prop shape via null == indeterminate. Named CheckedState so it
        /// cannot shadow the base CheckBox.Checked event.</summary>
        public bool? CheckedState
        {
            get => IsChecked;
            set => IsChecked = value;
        }

        public MuiCheckbox()
        {
            // #3069: the default CheckBox template fills the checked and
            // indeterminate box with the CheckBoxCheckBackgroundFill*
            // system-accent theme brushes. The web checkbox fills with
            // color.primary and draws the glyph in color.text-main
            // (mui-checkbox.component.scss `.mark.is-checked` /
            // `.mark.is-indeterminate`) — re-point the per-control theme
            // brushes at the same Maple tokens.
            foreach (var key in new[]
            {
                "CheckBoxCheckBackgroundFillChecked", "CheckBoxCheckBackgroundFillCheckedPointerOver", "CheckBoxCheckBackgroundFillCheckedPressed",
                "CheckBoxCheckBackgroundStrokeChecked", "CheckBoxCheckBackgroundStrokeCheckedPointerOver", "CheckBoxCheckBackgroundStrokeCheckedPressed",
                "CheckBoxCheckBackgroundFillIndeterminate", "CheckBoxCheckBackgroundFillIndeterminatePointerOver", "CheckBoxCheckBackgroundFillIndeterminatePressed",
                "CheckBoxCheckBackgroundStrokeIndeterminate", "CheckBoxCheckBackgroundStrokeIndeterminatePointerOver", "CheckBoxCheckBackgroundStrokeIndeterminatePressed",
            })
                Resources[key] = R("MaplePrimary");
            foreach (var key in new[]
            {
                "CheckBoxCheckGlyphForegroundChecked", "CheckBoxCheckGlyphForegroundCheckedPointerOver", "CheckBoxCheckGlyphForegroundCheckedPressed",
                "CheckBoxCheckGlyphForegroundIndeterminate", "CheckBoxCheckGlyphForegroundIndeterminatePointerOver", "CheckBoxCheckGlyphForegroundIndeterminatePressed",
            })
                Resources[key] = R("MapleTextMain");

            IsThreeState = true;
            Checked += (_, _) => Rebuild();
            Unchecked += (_, _) => Rebuild();
            Indeterminate += (_, _) => Rebuild();
            IsEnabledChanged += (_, _) => Rebuild();
            Rebuild();
        }

        private static Microsoft.UI.Xaml.Media.Brush R(string key) =>
            (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            Content = Label;

            // checkbox.md § States, Disabled: 40-50% opacity, matching
            // every other atom's disabled treatment.
            Opacity = IsEnabled ? 1.0 : 0.45;

            if (!string.IsNullOrEmpty(Label))
                AutomationProperties.SetName(this, Label);
        }
    }
}

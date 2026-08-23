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
    /// KNOWN GAP: this wave leaves the checkbox glyph itself
    /// (box/checkmark/dash) at its Fluent-default rendering rather than
    /// recoloring it to `color.primary`/`radius.xs` — same "no
    /// ControlTemplate rewrite without a compiler to check it against"
    /// reasoning MuiStyles.xaml's header comment gives for Button/Action
    /// Button hover states.
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
        /// prop shape via null == indeterminate.</summary>
        public bool? Checked
        {
            get => IsChecked;
            set => IsChecked = value;
        }

        public MuiCheckbox()
        {
            IsThreeState = true;
            Checked += (_, _) => Rebuild();
            Unchecked += (_, _) => Rebuild();
            Indeterminate += (_, _) => Rebuild();
            IsEnabledChanged += (_, _) => Rebuild();
            Rebuild();
        }

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

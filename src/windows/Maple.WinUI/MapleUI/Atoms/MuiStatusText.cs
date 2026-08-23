using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>Status Text state (unified-component-catalog.md §1.5
    /// Feedback, "Status Text" row: "States: idle, saving, saved, offline,
    /// error").</summary>
    public enum MuiStatusTextState { Idle, Saving, Saved, Offline, Error }

    /// <summary>
    /// Maple.UI Status Text atom (unified-component-catalog.md §1.5
    /// Feedback, "Status Text" row: "Persistence / sync state line · Icon
    /// pairing") — the small inline "Saving… / Saved / Offline" line seen
    /// next to a sidecar-backed edit surface.
    ///
    /// Saving pairs with a live <see cref="MuiSpinner"/> rather than a
    /// static icon (an in-progress state reads better as visibly moving).
    /// Idle/Offline both reuse the registry's plain "dot" glyph (recolored
    /// per state) — the chrome icon set has no dedicated
    /// wifi-off/cloud-offline glyph, and adding one means hand-syncing the
    /// Web/Apple registries too (MapleIconShapes.cs's own header comment),
    /// out of scope for this wave; the accompanying text still
    /// distinguishes the two per the "never color alone" accessibility
    /// rule every atom in this library follows.
    /// </summary>
    public sealed class MuiStatusText : ContentControl
    {
        public static readonly DependencyProperty StateProperty =
            DependencyProperty.Register(nameof(State), typeof(MuiStatusTextState), typeof(MuiStatusText),
                new PropertyMetadata(MuiStatusTextState.Idle, (d, _) => ((MuiStatusText)d).Rebuild()));

        public static readonly DependencyProperty TextProperty =
            DependencyProperty.Register(nameof(Text), typeof(string), typeof(MuiStatusText),
                new PropertyMetadata(null, (d, _) => ((MuiStatusText)d).Rebuild()));

        public MuiStatusTextState State
        {
            get => (MuiStatusTextState)GetValue(StateProperty);
            set => SetValue(StateProperty, value);
        }

        /// <summary>Overrides the default per-state caption (e.g.
        /// "Saved 2m ago" instead of the default "Saved"). Null uses the
        /// default.</summary>
        public string? Text
        {
            get => (string?)GetValue(TextProperty);
            set => SetValue(TextProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
        private readonly MuiIcon _icon = new() { Size = MuiIconSize.Xs14 };
        private readonly MuiSpinner _spinner = new() { SpinnerSize = MuiSpinnerSize.Sm, Inline = true, DelayMs = 0 };
        private readonly TextBlock _label = new() { FontSize = 12, VerticalAlignment = VerticalAlignment.Center };

        public MuiStatusText()
        {
            _root.Children.Add(_icon);
            _root.Children.Add(_spinner);
            _root.Children.Add(_label);
            Content = _root;
            IsTabStop = false;
            AutomationProperties.SetAccessibilityView(this, AccessibilityView.Content);

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private static string DefaultTextFor(MuiStatusTextState state) => state switch
        {
            MuiStatusTextState.Saving => "Saving…",
            MuiStatusTextState.Saved => "Saved",
            MuiStatusTextState.Offline => "Offline",
            MuiStatusTextState.Error => "Couldn't save",
            _ => "Idle",
        };

        private void Rebuild()
        {
            var isSaving = State == MuiStatusTextState.Saving;

            _icon.Visibility = isSaving ? Visibility.Collapsed : Visibility.Visible;
            _spinner.IsSpinning = isSaving;
            _spinner.Visibility = isSaving ? Visibility.Visible : Visibility.Collapsed;

            var (iconName, brush) = State switch
            {
                MuiStatusTextState.Saved => ("check", R("MapleSuccessText")),
                MuiStatusTextState.Offline => ("dot", R("MapleWarn")),
                MuiStatusTextState.Error => ("x", R("MapleErrorText")),
                _ => ("dot", R("MapleTextMuted")),
            };
            _icon.IconName = iconName;
            _icon.IconColor = brush;

            _label.Text = Text ?? DefaultTextFor(State);
            _label.Foreground = State switch
            {
                MuiStatusTextState.Saved => R("MapleSuccessText"),
                MuiStatusTextState.Offline => R("MapleWarn"),
                MuiStatusTextState.Error => R("MapleErrorText"),
                _ => R("MapleTextMuted"),
            };

            AutomationProperties.SetName(this, _label.Text);
        }
    }
}

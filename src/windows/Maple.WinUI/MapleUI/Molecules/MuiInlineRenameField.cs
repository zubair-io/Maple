using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Inline Rename Field molecule (unified-component-catalog.md
    /// §2.1, "Inline Rename Field" row: "Edit-in-place name", built from
    /// Input, Text) — renders as static text until activated (tap, or the
    /// public <see cref="StartEditing"/>), then swaps to a MuiInput with a
    /// commit/cancel affordance.
    ///
    /// Ports `mui-inline-rename-field.component.ts`'s commit/cancel
    /// contract: Enter or blur with a real, non-empty, changed value commits
    /// (fires <see cref="Renamed"/>); Escape cancels back to the prior
    /// value without emitting. MuiInput's own Committed event already fires
    /// on Enter/blur, so this molecule reuses that rather than re-wiring
    /// keydown/blur handling a second time — only Escape needs an extra
    /// KeyDown listener layered on top.
    /// </summary>
    public sealed class MuiInlineRenameField : ContentControl
    {
        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(string), typeof(MuiInlineRenameField),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiInlineRenameField)d).Rebuild()));

        public static readonly DependencyProperty AccessibleLabelProperty =
            DependencyProperty.Register(nameof(AccessibleLabel), typeof(string), typeof(MuiInlineRenameField),
                new PropertyMetadata("Name", (d, _) => ((MuiInlineRenameField)d).Rebuild()));

        public string Value
        {
            get => (string)GetValue(ValueProperty);
            set => SetValue(ValueProperty, value);
        }

        public string AccessibleLabel
        {
            get => (string)GetValue(AccessibleLabelProperty);
            set => SetValue(AccessibleLabelProperty, value);
        }

        /// <summary>Fires with the new name once a rename is committed
        /// (Enter, or blur with a real change).</summary>
        public event EventHandler<string>? Renamed;

        private readonly Grid _root = new();
        private readonly Border _displayHit = new() { Padding = new Thickness(2), CornerRadius = new CornerRadius(4) };
        private readonly StackPanel _displayRow = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
        private readonly MuiText _displayText = new() { Variant = MuiTextVariant.Body, Truncate = true };
        private readonly MuiIcon _editIcon = new() { IconName = "edit", Size = MuiIconSize.Xs14 };
        private readonly MuiInput _input = new() { Variant = MuiInputVariant.Default };

        private bool _editing;

        public MuiInlineRenameField()
        {
            _displayRow.Children.Add(_displayText);
            _displayRow.Children.Add(_editIcon);
            _displayHit.Child = _displayRow;
            _root.Children.Add(_displayHit);
            _root.Children.Add(_input);
            Content = _root;
            IsTabStop = false;

            _displayHit.Tapped += (_, _) => StartEditing();
            _input.Committed += (_, text) => Commit(text);
            _input.KeyDown += OnInputKeyDown;
            IsEnabledChanged += (_, _) => Rebuild();

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        /// <summary>Activates editing — same entry point a tap on the
        /// display text uses, exposed so a host (e.g. a rename toolbar
        /// button) can trigger it too.</summary>
        public void StartEditing()
        {
            if (!IsEnabled || _editing) return;
            _input.Text = Value;
            _editing = true;
            Rebuild();
            DispatcherQueue.TryEnqueue(() => _ = FocusManager.TryFocusAsync(_input, FocusState.Programmatic));
        }

        private void OnInputKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key != Windows.System.VirtualKey.Escape) return;
            e.Handled = true;
            Cancel();
        }

        private void Commit(string rawText)
        {
            if (!_editing) return;
            _editing = false;
            Rebuild();
            // A rename never commits blank — same allowEmpty:false policy
            // MuiPlaceRow (L2) uses for its own override field, both
            // routed through the shared MuiInlineEditLogic rule.
            var next = MuiInlineEditLogic.ResolveCommit(rawText, Value, allowEmpty: false);
            if (next is null) return;
            Value = next;
            Renamed?.Invoke(this, next);
        }

        private void Cancel()
        {
            if (!_editing) return;
            _editing = false;
            Rebuild();
        }

        private void Rebuild()
        {
            _displayText.Text = Value;
            _displayHit.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            _editIcon.IconColor = R("MapleTextMuted");

            _displayHit.Visibility = _editing ? Visibility.Collapsed : Visibility.Visible;
            _input.Visibility = _editing ? Visibility.Visible : Visibility.Collapsed;

            Opacity = IsEnabled ? 1.0 : 0.45;

            var name = string.IsNullOrEmpty(Value) ? AccessibleLabel : $"{AccessibleLabel}: {Value}";
            AutomationProperties.SetName(this, name);
        }
    }
}

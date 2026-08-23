using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Dialog variant (unified-component-catalog.md §3, "Dialog"
    /// row + `mui-dialog.component.ts`'s <c>MuiDialogVariant</c>).</summary>
    public enum MuiDialogVariant { Confirm, Prompt }

    /// <summary>
    /// Maple.UI Dialog molecule (unified-component-catalog.md §3, "Dialog"
    /// row: "Prompt, confirm, or choice", built from Popover, Text, Input,
    /// Button) — a MODAL overlay, per this wave's brief ("modal
    /// ContentDialog-free"): a token-styled <see cref="Popup"/> scrim
    /// covering the whole <see cref="UIElement.XamlRoot"/> rather than the
    /// platform <c>ContentDialog</c>, whose chrome isn't driven by Maple's
    /// own tokens.
    ///
    /// Distinct from <see cref="MuiPopover"/> (which anchors against a
    /// trigger's own layout rect) exactly the way `mui-dialog.component.ts`'s
    /// doc comment explains: a full-viewport scrim has no trigger to anchor
    /// against, so this control does NOT compose MuiPopover — it re-derives
    /// the same "focus on open, dismiss on Escape or scrim click" shape
    /// `OverlayFocusBase` gives the web port, using
    /// <see cref="XamlRoot.Size"/> (kept current via
    /// <see cref="XamlRoot.Changed"/> while open, e.g. a window resize) to
    /// size the scrim, since a WinUI <see cref="Popup"/> — unlike a CSS
    /// `position: fixed` div — isn't auto-sized to its window.
    ///
    /// Result state (which action closed the dialog, and with what value)
    /// is <see cref="MuiDialogLogic"/> — plain C#, unit-tested without a
    /// live Window.
    /// </summary>
    public sealed class MuiDialog : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiDialog),
                new PropertyMetadata(false, (d, _) => ((MuiDialog)d).ApplyOpenState()));

        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiDialog),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiDialog)d).Rebuild()));

        public static readonly DependencyProperty MessageProperty =
            DependencyProperty.Register(nameof(Message), typeof(string), typeof(MuiDialog),
                new PropertyMetadata(null, (d, _) => ((MuiDialog)d).Rebuild()));

        public static readonly DependencyProperty VariantProperty =
            DependencyProperty.Register(nameof(Variant), typeof(MuiDialogVariant), typeof(MuiDialog),
                new PropertyMetadata(MuiDialogVariant.Confirm, (d, _) => ((MuiDialog)d).Rebuild()));

        public static readonly DependencyProperty ConfirmLabelProperty =
            DependencyProperty.Register(nameof(ConfirmLabel), typeof(string), typeof(MuiDialog),
                new PropertyMetadata("Confirm", (d, _) => ((MuiDialog)d).Rebuild()));

        public static readonly DependencyProperty CancelLabelProperty =
            DependencyProperty.Register(nameof(CancelLabel), typeof(string), typeof(MuiDialog),
                new PropertyMetadata("Cancel", (d, _) => ((MuiDialog)d).Rebuild()));

        public static readonly DependencyProperty DestructiveProperty =
            DependencyProperty.Register(nameof(Destructive), typeof(bool), typeof(MuiDialog),
                new PropertyMetadata(false, (d, _) => ((MuiDialog)d).Rebuild()));

        public static readonly DependencyProperty PromptPlaceholderProperty =
            DependencyProperty.Register(nameof(PromptPlaceholder), typeof(string), typeof(MuiDialog),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiDialog)d).Rebuild()));

        public static readonly DependencyProperty PromptValueProperty =
            DependencyProperty.Register(nameof(PromptValue), typeof(string), typeof(MuiDialog),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiDialog)d)._promptInput.Text = (string)e.NewValue));

        public bool IsOpen
        {
            get => (bool)GetValue(IsOpenProperty);
            set => SetValue(IsOpenProperty, value);
        }

        public string Title
        {
            get => (string)GetValue(TitleProperty);
            set => SetValue(TitleProperty, value);
        }

        public string? Message
        {
            get => (string?)GetValue(MessageProperty);
            set => SetValue(MessageProperty, value);
        }

        public MuiDialogVariant Variant
        {
            get => (MuiDialogVariant)GetValue(VariantProperty);
            set => SetValue(VariantProperty, value);
        }

        public string ConfirmLabel
        {
            get => (string)GetValue(ConfirmLabelProperty);
            set => SetValue(ConfirmLabelProperty, value);
        }

        public string CancelLabel
        {
            get => (string)GetValue(CancelLabelProperty);
            set => SetValue(CancelLabelProperty, value);
        }

        public bool Destructive
        {
            get => (bool)GetValue(DestructiveProperty);
            set => SetValue(DestructiveProperty, value);
        }

        public string PromptPlaceholder
        {
            get => (string)GetValue(PromptPlaceholderProperty);
            set => SetValue(PromptPlaceholderProperty, value);
        }

        /// <summary>Bound value for the Prompt variant's input field.
        /// Unused (and left untouched) for Confirm.</summary>
        public string PromptValue
        {
            get => (string)GetValue(PromptValueProperty);
            set => SetValue(PromptValueProperty, value);
        }

        /// <summary>Fires with the current PromptValue (empty for Confirm)
        /// when the confirm action is taken.</summary>
        public event EventHandler<string>? Confirmed;

        /// <summary>Fires on Escape, a scrim click, or Cancel.</summary>
        public event EventHandler? Dismissed;

        private readonly Popup _popup = new() { IsLightDismissEnabled = false };
        private readonly Grid _scrim = new();
        // ContentControl, not Border — IsTabStop/Focus need a real Control;
        // a bare Border can't take keyboard focus (same reasoning
        // MuiPopover's own _panelHost doc comment gives).
        private readonly ContentControl _panel = new()
        {
            IsTabStop = true,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(20),
            Width = 360,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        private readonly StackPanel _panelBody = new() { Orientation = Orientation.Vertical, Spacing = 12 };
        private readonly MuiText _titleText = new() { Variant = MuiTextVariant.RowLabel };
        private readonly MuiText _messageText = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
        private readonly MuiInput _promptInput = new() { Variant = MuiInputVariant.Default };
        private readonly StackPanel _actions = new() { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
        private readonly MuiButton _cancelButton = new() { Variant = MuiButtonVariant.Ghost };
        private readonly MuiButton _confirmButton = new();

        public MuiDialog()
        {
            _panelBody.Children.Add(_titleText);
            _panelBody.Children.Add(_messageText);
            _panelBody.Children.Add(_promptInput);
            _actions.Children.Add(_cancelButton);
            _actions.Children.Add(_confirmButton);
            _panelBody.Children.Add(_actions);
            _panel.Content = _panelBody;
            _scrim.Children.Add(_panel);
            _popup.Child = _scrim;

            IsTabStop = false;
            IsHitTestVisible = false;
            Visibility = Visibility.Collapsed;

            _scrim.Tapped += (_, _) => Cancel();
            _panel.Tapped += (_, e) => e.Handled = true;
            _panel.KeyDown += OnPanelKeyDown;
            _cancelButton.Click += (_, _) => Cancel();
            _confirmButton.Click += (_, _) => Confirm();
            // Enter/blur only updates the bound value here (matching
            // `mui-dialog.component.html`'s `(committed)="promptValue.set($event)"`)
            // — Confirm stays an explicit, separate action via the button
            // or the Enter-to-confirm affordance a caller wires up itself.
            _promptInput.Committed += (_, text) => PromptValue = text;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnPanelKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key != VirtualKey.Escape) return;
            e.Handled = true;
            Cancel();
        }

        private void Confirm()
        {
            var result = MuiDialogLogic.Confirm(PromptValue);
            Confirmed?.Invoke(this, result.Value);
        }

        private void Cancel()
        {
            MuiDialogLogic.Cancel();
            Dismissed?.Invoke(this, EventArgs.Empty);
        }

        private void ApplyOpenState()
        {
            if (IsOpen)
            {
                if (XamlRoot != null)
                {
                    _popup.XamlRoot = XamlRoot;
                    XamlRoot.Changed += OnXamlRootChanged;
                    ResizeScrim();
                }
                _popup.IsOpen = true;
                DispatcherQueue.TryEnqueue(() => _ = FocusManager.TryFocusAsync(_panel, FocusState.Programmatic));
            }
            else
            {
                _popup.IsOpen = false;
                if (_popup.XamlRoot != null)
                    _popup.XamlRoot.Changed -= OnXamlRootChanged;
            }
        }

        private void OnXamlRootChanged(XamlRoot sender, XamlRootChangedEventArgs args) => ResizeScrim();

        private void ResizeScrim()
        {
            if (XamlRoot is null) return;
            _scrim.Width = XamlRoot.Size.Width;
            _scrim.Height = XamlRoot.Size.Height;
        }

        private void Rebuild()
        {
            _scrim.Background = new SolidColorBrush(Windows.UI.Color.FromArgb(0xA0, 0, 0, 0));
            _panel.Background = R("MapleSurface");
            _panel.BorderBrush = R("MapleBorder");

            _titleText.Text = Title;
            AutomationProperties.SetName(_panel, Title);

            _messageText.Text = Message ?? string.Empty;
            _messageText.Visibility = string.IsNullOrEmpty(Message) ? Visibility.Collapsed : Visibility.Visible;

            var isPrompt = Variant == MuiDialogVariant.Prompt;
            _promptInput.Visibility = isPrompt ? Visibility.Visible : Visibility.Collapsed;
            _promptInput.Placeholder = PromptPlaceholder;

            _cancelButton.Label = CancelLabel;
            _confirmButton.Label = ConfirmLabel;
            _confirmButton.Variant = Destructive ? MuiButtonVariant.Destructive : MuiButtonVariant.Primary;
        }
    }
}

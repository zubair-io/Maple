using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>The multi-field batch metadata edit.</summary>
    public sealed record MuiBatchMetadataEdit(string Caption, string Copyright, string Location);

    /// <summary>
    /// Maple.UI Batch Metadata modal organism (unified-component-catalog.md
    /// §4.4, "Batch Metadata" row: "Multi-field editor with confirm",
    /// built from Form Field, Dialog, Progress) — several
    /// <see cref="MuiFormField"/>s, an Apply action gated by a confirm
    /// <see cref="MuiDialog"/> (this overwrites metadata on every selected
    /// asset), and a determinate <see cref="MuiProgress"/> while applying.
    /// </summary>
    public sealed class MuiBatchMetadataModal : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiBatchMetadataModal),
                new PropertyMetadata(false, (d, e) => ((MuiBatchMetadataModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiBatchMetadataModal),
                new PropertyMetadata(false, (d, e) => ((MuiBatchMetadataModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty AssetCountProperty =
            DependencyProperty.Register(nameof(AssetCount), typeof(int), typeof(MuiBatchMetadataModal),
                new PropertyMetadata(0, (d, _) => ((MuiBatchMetadataModal)d).Rebuild()));

        public static readonly DependencyProperty IsApplyingProperty =
            DependencyProperty.Register(nameof(IsApplying), typeof(bool), typeof(MuiBatchMetadataModal),
                new PropertyMetadata(false, (d, _) => ((MuiBatchMetadataModal)d).Rebuild()));

        public static readonly DependencyProperty ApplyProgressProperty =
            DependencyProperty.Register(nameof(ApplyProgress), typeof(double), typeof(MuiBatchMetadataModal),
                new PropertyMetadata(0.0, (d, e) => ((MuiBatchMetadataModal)d)._progress.Value = (double)e.NewValue));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }
        public int AssetCount { get => (int)GetValue(AssetCountProperty); set => SetValue(AssetCountProperty, value); }
        public bool IsApplying { get => (bool)GetValue(IsApplyingProperty); set => SetValue(IsApplyingProperty, value); }
        public double ApplyProgress { get => (double)GetValue(ApplyProgressProperty); set => SetValue(ApplyProgressProperty, value); }

        public event EventHandler? Dismissed;
        public event EventHandler? CancelRequested;
        public event EventHandler<MuiBatchMetadataEdit>? ApplyRequested;

        // Production metadata fields and preview are supplied by the selection
        // adapter; the shared organism owns confirmation, progress and cancel.
        public UIElement? EditorContent
        {
            set
            {
                _fields.Children.Clear();
                if (value != null) _fields.Children.Add(value);
            }
        }
        public bool CanApply { get => _canApply; set { _canApply = value; Rebuild(); } }
        public string ApplyLabel { set { _apply.Label = value; _confirmDialog.ConfirmLabel = value; } }
        public string ConfirmationMessage { set { _confirmationMessage = value; Rebuild(); } }
        private string? _confirmationMessage;
        public string CancelLabel { set => _cancel.Label = value; }
        private bool _canApply = true;
        private readonly StackPanel _fields = new() { Spacing = 14 };
        private readonly ScrollViewer _embeddedScroll = new() { MaxHeight = 480 };
        public double EditorMaxHeight { set => _embeddedScroll.MaxHeight = value; }

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Md, AriaLabel = "Batch Metadata" };
        private readonly MuiInput _caption = new() { Placeholder = "Caption" };
        private readonly MuiInput _copyright = new() { Placeholder = "© 2026 Just Maple" };
        private readonly MuiInput _location = new() { Placeholder = "Location" };
        private readonly MuiProgress _progress = new() { Width = 100 };
        private readonly MuiButton _cancel = new() { Variant = MuiButtonVariant.Ghost, Label = "Cancel" };
        private readonly MuiButton _apply = new() { Variant = MuiButtonVariant.Primary, Label = "Apply" };
        private readonly MuiDialog _confirmDialog = new() { Variant = MuiDialogVariant.Confirm, Title = "Apply to all selected?", ConfirmLabel = "Apply" };

        public MuiBatchMetadataModal() : this(false) { }

        public MuiBatchMetadataModal(bool embedded)
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 14 };
            _fields.Children.Add(new MuiFormField { Label = "Caption", ControlContent = _caption });
            _fields.Children.Add(new MuiFormField { Label = "Copyright", ControlContent = _copyright });
            _fields.Children.Add(new MuiFormField { Label = "Location", ControlContent = _location });
            body.Children.Add(_fields);
            body.Children.Add(_confirmDialog);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_progress);
            footer.Children.Add(_cancel);
            footer.Children.Add(_apply);

            var heading = new MuiText { Text = "Batch Metadata", Variant = MuiTextVariant.SheetTitle };
            if (embedded)
            {
                // ContentDialog supplies the modal surface, focus trap and
                // scrim. Do not nest a second overlay inside its body.
                var panel = new Grid { RowSpacing = 16 };
                panel.RowDefinitions.Add(new() { Height = GridLength.Auto });
                panel.RowDefinitions.Add(new() { Height = new GridLength(1, GridUnitType.Star) });
                panel.RowDefinitions.Add(new() { Height = GridLength.Auto });
                _embeddedScroll.Content = body;
                _embeddedScroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
                Grid.SetRow(_embeddedScroll, 1);
                Grid.SetRow(footer, 2);
                panel.Children.Add(heading);
                panel.Children.Add(_embeddedScroll);
                panel.Children.Add(footer);
                Content = panel;
            }
            else
            {
                _shell.Header = heading;
                _shell.Body = body;
                _shell.Footer = footer;
                Content = _shell;
            }
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => RequestDismiss();
            _cancel.Click += (_, _) => RequestDismiss();
            _apply.Click += (_, _) => _confirmDialog.IsOpen = true;
            _confirmDialog.Dismissed += (_, _) => _confirmDialog.IsOpen = false;
            _confirmDialog.Confirmed += (_, _) =>
            {
                _confirmDialog.IsOpen = false;
                ApplyRequested?.Invoke(this, new MuiBatchMetadataEdit(_caption.Text, _copyright.Text, _location.Text));
            };

            Rebuild();
        }

        private void Rebuild()
        {
            _confirmDialog.Message = _confirmationMessage ?? $"This will overwrite metadata on {AssetCount} asset{(AssetCount == 1 ? "" : "s")}.";
            _progress.Visibility = IsApplying ? Visibility.Visible : Visibility.Collapsed;
            _apply.IsEnabled = !IsApplying && CanApply;
        }

        private void RequestDismiss()
        {
            if (IsApplying) { CancelRequested?.Invoke(this, EventArgs.Empty); return; }
            IsOpen = false;
            Dismissed?.Invoke(this, EventArgs.Empty);
        }
    }
}

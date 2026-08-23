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
        public event EventHandler<MuiBatchMetadataEdit>? ApplyRequested;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Md, AriaLabel = "Batch Metadata" };
        private readonly MuiInput _caption = new() { Placeholder = "Caption" };
        private readonly MuiInput _copyright = new() { Placeholder = "© 2026 Just Maple" };
        private readonly MuiInput _location = new() { Placeholder = "Location" };
        private readonly MuiProgress _progress = new() { Width = 100 };
        private readonly MuiButton _cancel = new() { Variant = MuiButtonVariant.Ghost, Label = "Cancel" };
        private readonly MuiButton _apply = new() { Variant = MuiButtonVariant.Primary, Label = "Apply" };
        private readonly MuiDialog _confirmDialog = new() { Variant = MuiDialogVariant.Confirm, Title = "Apply to all selected?", ConfirmLabel = "Apply" };

        public MuiBatchMetadataModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 14 };
            body.Children.Add(new MuiFormField { Label = "Caption", ControlContent = _caption });
            body.Children.Add(new MuiFormField { Label = "Copyright", ControlContent = _copyright });
            body.Children.Add(new MuiFormField { Label = "Location", ControlContent = _location });
            body.Children.Add(_confirmDialog);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_progress);
            footer.Children.Add(_cancel);
            footer.Children.Add(_apply);

            _shell.Header = new MuiText { Text = "Batch Metadata", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _cancel.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
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
            _confirmDialog.Message = $"This will overwrite metadata on {AssetCount} asset{(AssetCount == 1 ? "" : "s")}.";
            _progress.Visibility = IsApplying ? Visibility.Visible : Visibility.Collapsed;
            _apply.IsEnabled = !IsApplying;
        }
    }
}

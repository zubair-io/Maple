using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Which step a Pair Device flow is on.</summary>
    public enum MuiPairDeviceStep { ShowCode, Scan, Connecting, Done }

    /// <summary>
    /// Maple.UI Pair Device modal organism (unified-component-catalog.md
    /// §4.4, "Pair Device" row: "Multi-step pairing flow", built from QR
    /// Code, QR Scanner, Progress, Progress Step) — a vertical list of
    /// three <see cref="MuiProgressStep"/>s (Show code / Scan / Connect),
    /// each Pending/Active/Done off <see cref="Step"/>; the Active step's
    /// own body swaps in a <see cref="MuiQrPlaceholder"/>, a
    /// <see cref="MuiQrScanner"/>, or an indeterminate
    /// <see cref="MuiProgress"/> ring.
    /// </summary>
    public sealed class MuiPairDeviceModal : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiPairDeviceModal),
                new PropertyMetadata(false, (d, e) => ((MuiPairDeviceModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiPairDeviceModal),
                new PropertyMetadata(false, (d, e) => ((MuiPairDeviceModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty StepProperty =
            DependencyProperty.Register(nameof(Step), typeof(MuiPairDeviceStep), typeof(MuiPairDeviceModal),
                new PropertyMetadata(MuiPairDeviceStep.ShowCode, (d, _) => ((MuiPairDeviceModal)d).Rebuild()));

        public static readonly DependencyProperty PayloadProperty =
            DependencyProperty.Register(nameof(Payload), typeof(string), typeof(MuiPairDeviceModal),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiPairDeviceModal)d)._qrCode.Payload = (string)e.NewValue));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }
        public MuiPairDeviceStep Step { get => (MuiPairDeviceStep)GetValue(StepProperty); set => SetValue(StepProperty, value); }
        public string Payload { get => (string)GetValue(PayloadProperty); set => SetValue(PayloadProperty, value); }

        public event EventHandler? Dismissed;
        public event EventHandler<string>? CodeScanned;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Sm, AriaLabel = "Pair Device" };
        private readonly MuiProgressStep _showCodeStep = new() { Index = 0, Label = "Show a code on this device", ContinueLabel = "I've scanned it" };
        private readonly MuiProgressStep _scanStep = new() { Index = 1, Label = "Scan the other device's code", ContinueLabel = "Continue" };
        private readonly MuiProgressStep _connectStep = new() { Index = 2, Label = "Connecting…" };
        private readonly MuiQrPlaceholder _qrCode = new() { PlaceholderSize = MuiQrPlaceholderSize.Lg };
        private readonly MuiQrScanner _scanner = new();
        private readonly MuiProgress _connecting = new() { ProgressShape = MuiProgressShape.Ring, IsIndeterminate = true };
        private readonly MuiButton _close = new() { Variant = MuiButtonVariant.Ghost, Label = "Close" };

        public MuiPairDeviceModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 16 };
            body.Children.Add(_showCodeStep);
            body.Children.Add(_qrCode);
            body.Children.Add(_scanStep);
            body.Children.Add(_scanner);
            body.Children.Add(_connectStep);
            body.Children.Add(_connecting);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_close);

            _shell.Header = new MuiText { Text = "Pair Device", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _close.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _showCodeStep.Continued += (_, _) => Step = MuiPairDeviceStep.Scan;
            _scanner.Scanned += (_, code) => { Step = MuiPairDeviceStep.Connecting; CodeScanned?.Invoke(this, code); };

            Rebuild();
        }

        private void Rebuild()
        {
            _showCodeStep.Status = StatusFor(MuiPairDeviceStep.ShowCode);
            _scanStep.Status = StatusFor(MuiPairDeviceStep.Scan);
            _connectStep.Status = StatusFor(MuiPairDeviceStep.Connecting);

            _qrCode.Visibility = Step == MuiPairDeviceStep.ShowCode ? Visibility.Visible : Visibility.Collapsed;
            _scanner.Visibility = Step == MuiPairDeviceStep.Scan ? Visibility.Visible : Visibility.Collapsed;
            _connecting.Visibility = Step == MuiPairDeviceStep.Connecting ? Visibility.Visible : Visibility.Collapsed;
        }

        private MuiProgressStepStatus StatusFor(MuiPairDeviceStep step) => (int)Step == (int)step
            ? MuiProgressStepStatus.Active
            : (int)Step > (int)step ? MuiProgressStepStatus.Done : MuiProgressStepStatus.Pending;
    }
}

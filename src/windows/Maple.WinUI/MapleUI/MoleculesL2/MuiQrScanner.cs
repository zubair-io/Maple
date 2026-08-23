using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI QR Scanner molecule (unified-component-catalog.md §3, "QR
    /// Scanner" row: "Camera or paste payload capture", built from Input,
    /// Button, Canvas Surface).
    ///
    /// The paste path is the fully-supported path here, per this wave's
    /// brief: a text field plus a "Use code" action that emits
    /// <see cref="Scanned"/> with the trimmed payload — no camera or decode
    /// dependency required, matching `mui-qr-scanner.component.ts`'s own
    /// paste flow. The camera path is explicitly OUT of scope for Windows
    /// v1 (see #3012): WinUI 3 desktop has no `getUserMedia`-equivalent
    /// drop-in — a real live feed needs the Windows.Media.Capture
    /// (<c>MediaCapture</c>) API wired to a <c>CaptureElement</c>/swap-chain
    /// surface, camera-permission plumbing, and device enumeration, none of
    /// which this wave's no-local-compiler conditions can verify against.
    /// The <see cref="MuiCanvasSurface"/> slot the catalog calls for renders
    /// a static "camera capture isn't available yet — paste a payload
    /// below" message instead of a stub live feed, so the affordance is
    /// honest about the gap rather than silently doing nothing.
    /// </summary>
    public sealed class MuiQrScanner : ContentControl
    {
        public event EventHandler<string>? Scanned;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 10 };
        private readonly MuiCanvasSurface _viewfinder = new() { IsLoading = false, Height = 120 };
        private readonly MuiText _viewfinderMessage = new()
        {
            Variant = MuiTextVariant.Body,
            ColorRole = MuiTextColorRole.Muted,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Text = "Camera capture isn't available on Windows yet — paste a payload below.",
        };
        private readonly StackPanel _pasteRow = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiInput _pasteInput = new() { Placeholder = "Paste pairing code", AccessibleLabel = "Pairing code" };
        private readonly MuiButton _useCodeButton = new() { Variant = MuiButtonVariant.Primary, Label = "Use code" };

        public MuiQrScanner()
        {
            _viewfinder.HostedContent = _viewfinderMessage;
            _pasteRow.Children.Add(_pasteInput);
            _pasteRow.Children.Add(_useCodeButton);
            _root.Children.Add(_viewfinder);
            _root.Children.Add(_pasteRow);
            Content = _root;
            IsTabStop = false;

            _pasteInput.Committed += (_, _) => SubmitPaste();
            _useCodeButton.Click += (_, _) => SubmitPaste();
        }

        private void SubmitPaste()
        {
            var trimmed = (_pasteInput.Text ?? string.Empty).Trim();
            if (trimmed.Length == 0) return;
            Scanned?.Invoke(this, trimmed);
            _pasteInput.Text = string.Empty;
        }
    }
}

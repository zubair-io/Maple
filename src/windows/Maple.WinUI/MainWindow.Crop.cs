using System;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI;
using Maple.WinUI.Models;

namespace Maple.WinUI
{
    /// <summary>
    /// Crop mode (#2582, editor controls on Maple.UI since MN2 #3051). While
    /// the Crop tool is armed the canvas shows the FULL frame with a live
    /// rotate (the web's CSS-rotate straighten preview — empty corners show
    /// exactly what the renderer will produce) under the interactive
    /// MuiCropOverlay. Disarming applies the display crop client-side,
    /// Apple-style: rotate the content about the canvas centre, clip to the
    /// crop rect, and scale the result to fill the fit box. The develop paths
    /// (export, preview publish) apply the same crop in raw-core via the
    /// sidecar's crs:Crop* fields.
    /// </summary>
    public sealed partial class MainWindow
    {
        private static readonly (string Id, string Label, double? Ratio)[] CropAspects =
        {
            ("free", "Free", null),
            ("original", "Original", null),          // resolved from the frame
            ("1:1", "1:1", 1.0),
            ("3:2", "3:2", 3.0 / 2),
            ("4:3", "4:3", 4.0 / 3),
            ("16:9", "16:9", 16.0 / 9),
            ("2:3", "2:3", 2.0 / 3),
            ("3:4", "3:4", 3.0 / 4),
            ("9:16", "9:16", 9.0 / 16),
        };

        private const double MinCropFraction = 0.05;

        private bool _cropArmed;

        private void BuildCropPanel()
        {
            CropToolbar.AspectPresets = CropAspects.Select(a => new MuiChip(a.Id, a.Label)).ToList();
            CropToolbar.SelectedAspectId = "free";
            CropToolbar.AspectSelected += (_, _) => OnCropAspectSelected();
            CropToolbar.StraightenChanged += (_, angle) =>
            {
                ViewModel.Adjustments.Crop = ViewModel.Adjustments.Crop with { Angle = angle };
                ViewModel.NotifyAdjustmentEdited();
                UpdateCropDisplay();
            };
            CropToolbar.ResetRequested += (_, _) => OnCropReset(CropToolbar, new RoutedEventArgs());
            CropOverlay.RectChanged += (_, rect) =>
            {
                if (ContentFitRect() is not { } f || f.W <= 0 || f.H <= 0)
                    return;
                var crop = ViewModel.Adjustments.Crop;
                ViewModel.Adjustments.Crop = crop with
                {
                    Left = rect.X / f.W,
                    Top = rect.Y / f.H,
                    Right = (rect.X + rect.Width) / f.W,
                    Bottom = (rect.Y + rect.Height) / f.H,
                };
                ViewModel.NotifyAdjustmentEdited();
            };
        }

        private void EnterCropMode()
        {
            _cropArmed = true;
            // Aspect is transient per entry (web crop-session contract).
            CropToolbar.SelectedAspectId = "free";
            CropToolbar.StraightenAngle = ViewModel.Adjustments.Crop.Angle;
            ResetZoom();                              // overlay math assumes fit
            UpdateCropDisplay();
        }

        private void ExitCropMode()
        {
            if (!_cropArmed)
                return;
            _cropArmed = false;
            CropOverlay.Visibility = Visibility.Collapsed;
            UpdateCropDisplay();
        }

        /// <summary>Fit rect of the displayed content inside ZoomHost.</summary>
        private (double X, double Y, double W, double H)? ContentFitRect()
        {
            var vw = ZoomHost.ActualWidth;
            var vh = ZoomHost.ActualHeight;
            if (vw <= 0 || vh <= 0)
                return null;
            double cw, ch;
            if (_gpuFrameDims is { } dims && ViewportSwapChainPanel.Visibility == Visibility.Visible)
            {
                cw = dims.Width;
                ch = dims.Height;                     // panel is 1 px = 1 DIP, centered
            }
            else
            {
                double bw = _viewportBitmap?.PixelWidth
                    ?? (ViewportImage.Source as Microsoft.UI.Xaml.Media.Imaging.BitmapImage)?.PixelWidth ?? 0;
                double bh = _viewportBitmap?.PixelHeight
                    ?? (ViewportImage.Source as Microsoft.UI.Xaml.Media.Imaging.BitmapImage)?.PixelHeight ?? 0;
                if (bw <= 0 || bh <= 0)
                    return null;
                var scale = Math.Min(vw / bw, vh / bh);
                cw = bw * scale;
                ch = bh * scale;
            }
            return ((vw - cw) / 2, (vh - ch) / 2, cw, ch);
        }

        /// <summary>Apply the crop presentation for the current state: armed =
        /// full frame + live rotate + overlay; disarmed + non-identity =
        /// rotate, clip, and fit-scale (rotate-then-crop, renderer order).</summary>
        private void UpdateCropDisplay()
        {
            var crop = ViewModel.Adjustments.Crop;
            var footprint = ContentFitRect();

            if (_cropArmed)
            {
                ZoomHost.Clip = null;
                ZoomHost.RenderTransform = null;
                CropRotateHost.RenderTransform = crop.Angle != 0
                    ? new RotateTransform { Angle = crop.Angle }
                    : null;
                if (footprint is { } f && _mode == ShellMode.Edit)
                {
                    var c = crop.RectIsValid ? crop : CropState.Identity with { Angle = crop.Angle };
                    CropOverlay.Visibility = Visibility.Visible;
                    // The overlay's canvas is Bounds-sized and Left/Top
                    // aligned inside ZoomHost — the margin walks it onto the
                    // image footprint, so overlay pixel space == footprint
                    // space (the coordinate contract MuiCropOverlay
                    // documents against MuiImageCanvas).
                    CropOverlay.Margin = new Thickness(f.X, f.Y, 0, 0);
                    CropOverlay.Bounds = new Windows.Foundation.Size(f.W, f.H);
                    CropOverlay.MinRegionWidth = f.W * MinCropFraction;
                    CropOverlay.MinRegionHeight = f.H * MinCropFraction;
                    CropOverlay.AspectRatio = ActiveAspectRatio(f.W, f.H);
                    CropOverlay.Rect = new MuiCropRect(
                        c.Left * f.W, c.Top * f.H,
                        (c.Right - c.Left) * f.W, (c.Bottom - c.Top) * f.H);
                }
                return;
            }

            CropOverlay.Visibility = Visibility.Collapsed;
            if (crop.IsIdentity || !crop.RectIsValid || footprint is not { } fp)
            {
                ZoomHost.Clip = null;
                ZoomHost.RenderTransform = null;
                CropRotateHost.RenderTransform = crop.Angle != 0
                    ? new RotateTransform { Angle = crop.Angle }
                    : null;
                return;
            }

            var vw = ZoomHost.ActualWidth;
            var vh = ZoomHost.ActualHeight;
            var rx = fp.X + crop.Left * fp.W;
            var ry = fp.Y + crop.Top * fp.H;
            var rw = (crop.Right - crop.Left) * fp.W;
            var rh = (crop.Bottom - crop.Top) * fp.H;
            var scale = Math.Min(vw / rw, vh / rh);

            CropRotateHost.RenderTransform = crop.Angle != 0
                ? new RotateTransform { Angle = crop.Angle }
                : null;
            ZoomHost.Clip = new RectangleGeometry
            {
                Rect = new Windows.Foundation.Rect(rx, ry, rw, rh),
            };
            // Move the crop centre onto the viewport centre, then scale the
            // clipped region up to fit. RenderTransformOrigin (0.5, 0.5) makes
            // the scale viewport-centred.
            ZoomHost.RenderTransformOrigin = new Windows.Foundation.Point(0.5, 0.5);
            ZoomHost.RenderTransform = new TransformGroup
            {
                Children =
                {
                    new TranslateTransform
                    {
                        X = vw / 2 - (rx + rw / 2),
                        Y = vh / 2 - (ry + rh / 2),
                    },
                    new ScaleTransform { ScaleX = scale, ScaleY = scale },
                },
            };
        }

        /// <summary>Aspect (width/height) in footprint-pixel space — the
        /// space MuiCropOverlay resizes in. The footprint preserves the
        /// image's aspect, so preset ratios pass through unchanged.</summary>
        private double? ActiveAspectRatio(double footprintW, double footprintH)
        {
            var id = CropToolbar.SelectedAspectId;
            return id switch
            {
                "original" => footprintW / footprintH,
                _ => CropAspects.FirstOrDefault(a => a.Id == id).Ratio,
            };
        }

        private void OnCropAspectSelected()
        {
            if (!_cropArmed || ContentFitRect() is not { } f)
                return;
            if (ActiveAspectRatio(f.W, f.H) is not { } ratio)
            {
                UpdateCropDisplay();
                return;
            }
            // Snap to the largest centered rect of that ratio (web
            // centeredCropForAspect), preserving the angle.
            var k = ratio * f.H / f.W;               // normalized width per height
            var wN = Math.Min(1, k);
            var hN = wN / k;
            var crop = ViewModel.Adjustments.Crop with
            {
                Left = (1 - wN) / 2,
                Right = (1 + wN) / 2,
                Top = (1 - hN) / 2,
                Bottom = (1 + hN) / 2,
            };
            ViewModel.Adjustments.Crop = crop;
            ViewModel.NotifyAdjustmentEdited();
            UpdateCropDisplay();
        }

        private void OnCropReset(object sender, RoutedEventArgs e)
        {
            ViewModel.Adjustments.Crop = CropState.Identity;
            ViewModel.NotifyAdjustmentEdited();
            CropToolbar.SelectedAspectId = "free";
            CropToolbar.StraightenAngle = 0;
            UpdateCropDisplay();
        }

        private void OnCropDone(object sender, RoutedEventArgs e) => CloseGroupPanel();

        /// <summary>Model → crop UI (undo, sidecar reload, photo switch).</summary>
        private void SyncCropFromModel()
        {
            CropToolbar.StraightenAngle = ViewModel.Adjustments.Crop.Angle;
            UpdateCropDisplay();
        }
    }
}

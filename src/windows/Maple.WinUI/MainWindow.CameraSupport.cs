using System;
using System.IO;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;
using Maple.UI.Atoms;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        /// <summary>Resolve on demand for Preview's Info flyout. Editing also
        /// seeds this record from the render-time decode, so reopening Info is free.</summary>
        private async void AddCameraSupport(StackPanel host, PhotoItem photo)
        {
            // Already-rendered formats have no sensor calibration to assess.
            if (Path.GetExtension(photo.FileName).ToLowerInvariant()
                is ".jpg" or ".jpeg" or ".tif" or ".tiff" or ".png" or ".webp" or ".avif" or ".heic")
                return;
            var panel = new StackPanel { Spacing = 4, Margin = new Thickness(0, 4, 0, 8) };
            AutomationProperties.SetName(panel, "Camera and lens support");
            var label = new MuiText { Text = "Assessing camera support…", Variant = MuiTextVariant.Body };
            var explanation = new MuiText { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
            var lensLabel = new MuiText { Variant = MuiTextVariant.Body };
            var lensExplanation = new MuiText { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
            panel.Children.Add(label);
            panel.Children.Add(explanation);
            panel.Children.Add(lensLabel);
            panel.Children.Add(lensExplanation);
            host.Children.Add(panel);
            if (photo.IsCloud && photo.LocalCachePath == null)
            {
                label.Text = "Camera support not assessed";
                explanation.Text = "Open this photo in Edit to assess the original's calibration.";
                return;
            }
            try
            {
                var path = photo.EditPath;
                var support = photo.CameraSupport ?? await Task.Run(() => CameraSupportMetadata.ReadFile(path));
                if (photo.EditPath != path) return;
                photo.CameraSupport = support;
                label.Text = $"Camera support: {support.Label}";
                explanation.Text = support.Explanation;
                lensLabel.Text = $"Lens support: {support.LensLabel}";
                lensExplanation.Text = support.LensExplanation;
                if (ReferenceEquals(photo, ViewModel.SelectedPhoto) && ViewModel.LensProfileFacts?.Source == "lcp")
                {
                    lensLabel.Text = "Lens support: Imported profile";
                    lensExplanation.Text = ViewModel.LensProfileFacts.Description;
                }
            }
            catch (Exception ex)
            {
                label.Text = "Camera support not assessed";
                explanation.Text = ex.Message;
                DiagLog.Write($"[camera-support] {photo.FileName}: {ex.Message}");
            }
        }
    }
}

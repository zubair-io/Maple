using System;
using System.ComponentModel;
using System.IO;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;
using Maple.UI.Atoms;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        /// <summary>Show the render-time calibration copied into the photo by
        /// the generation-guarded Edit decode; opening Info never decodes a RAW.</summary>
        private void AddCameraSupport(StackPanel host, PhotoItem photo)
        {
            // Already-rendered formats have no sensor calibration to assess.
            if (Path.GetExtension(photo.FileName).ToLowerInvariant()
                is ".jpg" or ".jpeg" or ".tif" or ".tiff" or ".png" or ".webp" or ".avif" or ".heic")
                return;
            var panel = new StackPanel { Spacing = 4, Margin = new Thickness(0, 4, 0, 8) };
            AutomationProperties.SetName(panel, "Camera and lens support");
            var label = new MuiText { Variant = MuiTextVariant.Body };
            var explanation = new MuiText { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
            var lensLabel = new MuiText { Variant = MuiTextVariant.Body };
            var lensExplanation = new MuiText { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
            panel.Children.Add(label);
            panel.Children.Add(explanation);
            panel.Children.Add(lensLabel);
            panel.Children.Add(lensExplanation);
            host.Children.Add(panel);
            void UpdateSupport()
            {
                if (!ReferenceEquals(ViewModel.SelectedPhoto, photo)) return;
                var support = photo.CameraSupport;
                if (support == null)
                {
                    label.Text = "Camera support not assessed";
                    explanation.Text = "Open this photo in Edit to assess the original's calibration.";
                    lensLabel.Text = string.Empty;
                    lensExplanation.Text = string.Empty;
                    return;
                }
                label.Text = $"Camera support: {support.Label}";
                explanation.Text = support.Explanation;
                lensLabel.Text = $"Lens support: {support.LensLabel}";
                lensExplanation.Text = support.LensExplanation;
            }

            void OnSupportChanged(object? sender, PropertyChangedEventArgs args)
            {
                if (args.PropertyName == nameof(PhotoItem.CameraSupport)) UpdateSupport();
            }

            // A decode may finish while Info is open. Subscribe only while this
            // panel is mounted, so previous flyouts cannot retain their photos.
            panel.Loaded += (_, _) =>
            {
                photo.PropertyChanged += OnSupportChanged;
                UpdateSupport();
            };
            panel.Unloaded += (_, _) => photo.PropertyChanged -= OnSupportChanged;
            UpdateSupport();
        }
    }
}

using CommunityToolkit.Mvvm.ComponentModel;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    [ObservableProperty] private bool _isRasterSource;

    private void PublishRasterCapabilities(bool raster)
    {
        IsRasterSource = raster;
        foreach (var section in Sections)
        foreach (var slider in section.Sliders)
        {
            if (slider.Label is not ("Contrast" or "Whites" or "Deconv" or "Deconv Sigma")) continue;
            slider.IsEnabled = !raster;
            slider.UnavailableReason = raster
                ? "This adjustment requires a RAW source. JPEG and TIFF already contain developed pixels."
                : string.Empty;
        }
    }
}

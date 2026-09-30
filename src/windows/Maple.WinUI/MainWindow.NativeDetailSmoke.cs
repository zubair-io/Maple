using System;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyNativeDetailAsync()
    {
        await SetActualSizeAsync();
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline && (NativeDetailOverlay.Visibility != Visibility.Visible
            || !ZoomReadout.Text.StartsWith("100%")))
            await Task.Delay(50);
        if (_nativeGeometry is not { } geometry || ContentFitRect() is not { } fit
            || Math.Abs(fit.W * ViewerScroll.ZoomFactor * DisplayScale / geometry.CropWidth - 1) > .002)
            throw new InvalidOperationException($"Actual Size did not resolve original pixels: zoom={ViewerScroll.ZoomFactor}, dpi={DisplayScale}, fit={ContentFitRect()}, source={_nativeGeometry?.CropWidth}, status={ZoomReadout.Text}");
        if (NativeDetailOverlay.Visibility != Visibility.Visible || NativeDetailOverlay.Source is not WriteableBitmap)
            throw new InvalidOperationException($"Native patch was not presented: {ZoomReadout.Text}");
        if (!ZoomReadout.Text.StartsWith("100%") || !ZoomReadout.Text.EndsWith("native detail"))
            throw new InvalidOperationException($"Native zoom readout is incorrect: {ZoomReadout.Text}");
        ResetZoom();
    }
}

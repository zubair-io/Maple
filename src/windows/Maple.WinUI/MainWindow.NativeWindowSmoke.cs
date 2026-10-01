using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Windows.Graphics;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyNativeWindowLayoutAsync(string output)
    {
        var originalSize = AppWindow.Size;
        var root = (FrameworkElement)Content;
        var photo = ViewModel.SelectedPhoto;
        var adjustments = ViewModel.Adjustments;
        var group = _activeGroup;
        try
        {
            foreach (var size in new[] { new SizeInt32(1440, 900), new SizeInt32(1024, 768) })
            {
                AppWindow.Resize(size);
                var deadline = Environment.TickCount64 + 5000;
                do
                {
                    await Task.Delay(100);
                    root.UpdateLayout();
                } while ((AppWindow.Size.Width != size.Width || AppWindow.Size.Height != size.Height) &&
                    Environment.TickCount64 < deadline);
                // Native size notifications and XAML measure run on separate dispatcher turns.
                await Task.Delay(200);
                root.UpdateLayout();
                await File.AppendAllTextAsync(Path.Combine(output, "native-window-layout.jsonl"),
                    JsonSerializer.Serialize(new
                    {
                        requestedWidth = size.Width, requestedHeight = size.Height,
                        actualWidth = AppWindow.Size.Width, actualHeight = AppWindow.Size.Height,
                        logicalWidth = root.ActualWidth, logicalHeight = root.ActualHeight,
                        rasterizationScale = root.XamlRoot.RasterizationScale
                    }) + Environment.NewLine);
                if (AppWindow.Size.Width != size.Width || AppWindow.Size.Height != size.Height)
                    throw new InvalidOperationException("Native window did not reach the requested qualification size");
                VerifyEditorHeaderBounds();
                if (!ReferenceEquals(photo, ViewModel.SelectedPhoto) || !ReferenceEquals(adjustments, ViewModel.Adjustments) ||
                    group != _activeGroup || EditPanel.Visibility != Visibility.Visible)
                    throw new InvalidOperationException("Native resize changed the selected document or active tool");
            }
        }
        finally
        {
            AppWindow.Resize(originalSize);
            await Task.Delay(200);
            root.UpdateLayout();
        }
    }
}

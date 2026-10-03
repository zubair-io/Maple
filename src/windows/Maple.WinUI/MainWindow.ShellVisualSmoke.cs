using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Windows.Graphics;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyShellVisualCheckpointsAsync(string output)
    {
        if (Array.IndexOf(Environment.GetCommandLineArgs(), "--shell-visual-checkpoints") < 0) return;
        var root = (FrameworkElement)Content;
        var originalSize = AppWindow.Size;
        var originalMode = _mode;
        var originalInfo = _infoPaneOpen;
        var originalCollapsed = FilmstripRail.IsCollapsed;
        var originalBrowse = _browseListDetail;
        var photo = ViewModel.SelectedPhoto;
        var originalSelection = ViewModel.SelectedPhotos.ToArray();
        var adjustments = ViewModel.Adjustments;
        try
        {
            AppWindow.Resize(new SizeInt32(1440, 960));
            var deadline = Environment.TickCount64 + 5000;
            while ((AppWindow.Size.Width != 1440 || AppWindow.Size.Height != 960) && Environment.TickCount64 < deadline)
                await Task.Delay(100);
            if (AppWindow.Size.Width != 1440 || AppWindow.Size.Height != 960)
                throw new InvalidOperationException("Shell visual window did not reach 1440x960");
            _infoPaneOpen = false;
            if (photo != null) RestoreBrowseSelection(new[] { photo }, photo);
            foreach (var name in new[] { "browse-grid", "browse-list", "preview-rail", "preview-list", "preview-info", "preview-list-info" })
            {
                if (name.StartsWith("browse", StringComparison.Ordinal))
                {
                    _browseListDetail = name == "browse-list";
                    SetMode(ShellMode.Browse);
                    UpdateBrowsePresentation();
                }
                else
                {
                    SetMode(ShellMode.Preview);
                    FilmstripRail.IsCollapsed = !name.StartsWith("preview-list", StringComparison.Ordinal);
                    _infoPaneOpen = name.EndsWith("info", StringComparison.Ordinal);
                    UpdateInfoPane();
                }
                await Task.Delay(300);
                root.UpdateLayout();
                if (!ReferenceEquals(photo, ViewModel.SelectedPhoto) || !ReferenceEquals(adjustments, ViewModel.Adjustments))
                    throw new InvalidOperationException($"Shell visual navigation changed the document: {name}");
                var checkpoint = Path.Combine(output, $"visual-{name}");
                if (File.Exists(checkpoint + ".continue"))
                    throw new InvalidOperationException("Shell visual qualification requires fresh checkpoints");
                await File.WriteAllTextAsync(checkpoint + ".ready", JsonSerializer.Serialize(new
                {
                    name, width = AppWindow.Size.Width, height = AppWindow.Size.Height,
                    logicalWidth = root.ActualWidth, logicalHeight = root.ActualHeight,
                    scale = root.XamlRoot.RasterizationScale, photoCount = ViewModel.Photos.Count
                }));
                deadline = Environment.TickCount64 + 180000;
                while (!File.Exists(checkpoint + ".continue"))
                {
                    if (Environment.TickCount64 >= deadline)
                        throw new TimeoutException($"Shell visual checkpoint not captured: {name}");
                    await Task.Delay(100);
                }
            }
        }
        finally
        {
            _browseListDetail = originalBrowse;
            _infoPaneOpen = originalInfo;
            FilmstripRail.IsCollapsed = originalCollapsed;
            SetMode(originalMode);
            UpdateBrowsePresentation();
            UpdateInfoPane();
            RestoreBrowseSelection(originalSelection, photo);
            AppWindow.Resize(originalSize);
            await Task.Delay(200);
            root.UpdateLayout();
        }
    }
}

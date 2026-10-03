using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
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
            await VerifyPreviewToggleScrollAsync(output);
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

    private async Task VerifyPreviewToggleScrollAsync(string output)
    {
        SetMode(ShellMode.Preview);
        var root = (FrameworkElement)Content;
        _infoPaneOpen = true;
        UpdateInfoPane();
        root.UpdateLayout();
        var scroll = FindDescendant<ScrollViewer>(FilmstripRail)
            ?? throw new InvalidOperationException("Preview navigation has no scroll viewer.");
        if (scroll.ScrollableHeight <= 0)
            throw new InvalidOperationException("Populated visual library must overflow the Preview navigation.");
        var button = FindDescendant<Button>(FilmstripRail)
            ?? throw new InvalidOperationException("Preview navigation has no sidebar toggle.");
        var invoke = FrameworkElementAutomationPeer.CreatePeerForElement(button)?.GetPattern(PatternInterface.Invoke) as IInvokeProvider
            ?? throw new InvalidOperationException("Preview sidebar toggle has no accessible Invoke pattern.");
        var photo = ViewModel.SelectedPhoto;
        var adjustments = ViewModel.Adjustments;
        var initialCollapsed = FilmstripRail.IsCollapsed;
        await WaitForBrowseScrollSettledAsync(root, scroll,
            () => scroll.ChangeView(null, scroll.ScrollableHeight * .65, null, true));
        var offset = scroll.VerticalOffset;
        if (offset <= 0) throw new InvalidOperationException("Preview scroll fixture did not reach the later rows.");
        for (var iteration = 0; iteration < 2; iteration++)
        {
            invoke.Invoke();
            for (var sample = 0; sample < 8; sample++)
            {
                await Task.Delay(50);
                root.UpdateLayout();
                if (Math.Abs(scroll.VerticalOffset - offset) > 1 ||
                    FilmstripRail.IsCollapsed != (iteration == 0 ? !initialCollapsed : initialCollapsed) ||
                    !ReferenceEquals(photo, ViewModel.SelectedPhoto) || !ReferenceEquals(adjustments, ViewModel.Adjustments) ||
                    !_infoPaneOpen || _mode != ShellMode.Preview)
                    throw new InvalidOperationException($"Preview sidebar toggle lost navigation state: "
                        + $"offset={scroll.VerticalOffset}, expected={offset}, iteration={iteration}");
            }
        }
        var activeId = FilmstripRail.ActiveId;
        var items = FilmstripRail.Items ?? throw new InvalidOperationException("Missing Preview navigation items.");
        await WaitForBrowseScrollSettledAsync(root, scroll, () => FilmstripRail.ActiveId = items[^1].Id);
        var lastCell = FilmstripCells(FilmstripRail).Last();
        var bounds = lastCell.TransformToVisual(scroll).TransformBounds(
            new Windows.Foundation.Rect(0, 0, lastCell.ActualWidth, lastCell.ActualHeight));
        if (bounds.Top < -.5 || bounds.Bottom > scroll.ViewportHeight + .5)
            throw new InvalidOperationException("Changing the active photo no longer follows its Preview thumbnail.");
        await WaitForBrowseScrollSettledAsync(root, scroll, () => FilmstripRail.ActiveId = activeId);
        await File.WriteAllTextAsync(Path.Combine(output, "preview-toggle-scroll.json"),
            JsonSerializer.Serialize(new { passed = true, offset, photoCount = ViewModel.Photos.Count, toggles = 2, activeFollow = true }));
        _infoPaneOpen = false;
        UpdateInfoPane();
    }
}

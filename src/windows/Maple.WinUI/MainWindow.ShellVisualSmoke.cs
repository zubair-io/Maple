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
    private static bool ShellVisualCheckpointsRequested => Environment.GetCommandLineArgs().Any(
        arg => arg is "--shell-visual-checkpoints" or "--shell-visual-checkpoints-narrow");

    private async Task VerifyShellVisualCheckpointsAsync(string output)
    {
        if (!ShellVisualCheckpointsRequested) return;
        var root = (FrameworkElement)Content;
        var originalSize = AppWindow.Size;
        var originalMode = _mode;
        var originalInfo = _infoPaneOpen;
        var originalCollapsed = FilmstripRail.IsCollapsed;
        var originalBrowse = _browseListDetail;
        var originalGroup = _activeGroup;
        var photo = ViewModel.SelectedPhoto;
        var originalSelection = ViewModel.SelectedPhotos.ToArray();
        var adjustments = ViewModel.Adjustments;
        try
        {
            var narrow = Environment.GetCommandLineArgs().Contains("--shell-visual-checkpoints-narrow");
            var logicalSize = narrow ? new SizeInt32(1024, 768) : new SizeInt32(1440, 960);
            var scale = root.XamlRoot.RasterizationScale;
            var clientSize = new SizeInt32(
                (int)Math.Round(logicalSize.Width * scale), (int)Math.Round(logicalSize.Height * scale));
            var deadline = Environment.TickCount64 + 5000;
            var resizeObserved = false;
            void ObserveResize(Microsoft.UI.Windowing.AppWindow sender, Microsoft.UI.Windowing.AppWindowChangedEventArgs args)
            {
                if (args.DidSizeChange) resizeObserved = true;
            }
            AppWindow.Changed += ObserveResize;
            try
            {
                AppWindow.ResizeClient(clientSize);
                // Caption compensation must use the completed initial resize,
                // not client dimensions left over from the previous viewport.
                while (!resizeObserved && !HasRequestedSize() && Environment.TickCount64 < deadline)
                    await Task.Delay(50);
                if (!resizeObserved && !HasRequestedSize())
                    throw new TimeoutException("Initial shell visual client resize was not observed.");
            }
            finally
            {
                AppWindow.Changed -= ObserveResize;
            }
            var compensationApplied = false;
            while (!HasRequestedSize() && Environment.TickCount64 < deadline)
            {
                await Task.Delay(100);
                root.UpdateLayout();
                // ResizeClient can include a standard-caption allowance despite
                // custom title-bar extension. Correct using measured client pixels.
                if (!compensationApplied && (AppWindow.ClientSize.Width != clientSize.Width || AppWindow.ClientSize.Height != clientSize.Height))
                {
                    // Client and outer dimensions can update asynchronously.
                    // Compensate once, then only observe; never compound a
                    // pending resize's delta on a later polling iteration.
                    compensationApplied = true;
                    AppWindow.Resize(new SizeInt32(
                        AppWindow.Size.Width + clientSize.Width - AppWindow.ClientSize.Width,
                        AppWindow.Size.Height + clientSize.Height - AppWindow.ClientSize.Height));
                }
            }
            if (!HasRequestedSize())
                throw new InvalidOperationException($"Shell visual client did not reach {logicalSize.Width}x{logicalSize.Height} DIPs: "
                    + $"client={AppWindow.ClientSize.Width}x{AppWindow.ClientSize.Height}, "
                    + $"content={root.ActualWidth}x{root.ActualHeight}, scale={root.XamlRoot.RasterizationScale}, "
                    + $"requestedClient={clientSize.Width}x{clientSize.Height}, initialScale={scale}.");

            bool HasRequestedSize() => AppWindow.ClientSize.Width == clientSize.Width
                && AppWindow.ClientSize.Height == clientSize.Height
                && Math.Abs(root.ActualWidth - logicalSize.Width) <= 1 / scale + .001
                && Math.Abs(root.ActualHeight - logicalSize.Height) <= 1 / scale + .001
                && Math.Abs(root.XamlRoot.RasterizationScale - scale) < .001;
            _infoPaneOpen = false;
            if (photo != null) RestoreBrowseSelection(new[] { photo }, photo);
            await VerifyPreviewToggleScrollAsync(output);
            foreach (var name in new[] { "browse-grid", "browse-list", "preview-rail", "preview-list", "preview-info", "preview-list-info",
                "editor-light", "editor-color", "editor-crop", "editor-comparison" })
            {
                if (name.StartsWith("browse", StringComparison.Ordinal))
                {
                    _browseListDetail = name == "browse-list";
                    SetMode(ShellMode.Browse);
                    UpdateBrowsePresentation();
                }
                else if (name.StartsWith("editor", StringComparison.Ordinal))
                {
                    await PrepareEditorVisualCheckpointAsync(name);
                }
                else
                {
                    SetMode(ShellMode.Preview);
                    FilmstripRail.IsCollapsed = !name.StartsWith("preview-list", StringComparison.Ordinal);
                    _infoPaneOpen = name.EndsWith("info", StringComparison.Ordinal);
                    UpdateInfoPane();
                }
                if (_mode == ShellMode.Preview && _infoPaneOpen)
                    await WaitForInspectorVisualReadyAsync();
                await Task.Delay(300);
                root.UpdateLayout();
                if (!HasRequestedSize()) throw new InvalidOperationException("Visual viewport changed before capture.");
                if (name.StartsWith("editor", StringComparison.Ordinal)) VerifyEditorHeaderBounds();
                if (!ReferenceEquals(photo, ViewModel.SelectedPhoto) || !ReferenceEquals(adjustments, ViewModel.Adjustments))
                    throw new InvalidOperationException($"Shell visual navigation changed the document: {name}");
                var checkpoint = Path.Combine(output, $"visual-{name}");
                if (File.Exists(checkpoint + ".continue"))
                    throw new InvalidOperationException("Shell visual qualification requires fresh checkpoints");
                await File.WriteAllTextAsync(checkpoint + ".ready", JsonSerializer.Serialize(new
                {
                    name, width = AppWindow.Size.Width, height = AppWindow.Size.Height,
                    clientWidth = AppWindow.ClientSize.Width, clientHeight = AppWindow.ClientSize.Height,
                    requestedLogicalWidth = logicalSize.Width, requestedLogicalHeight = logicalSize.Height,
                    logicalWidth = root.ActualWidth, logicalHeight = root.ActualHeight,
                    scale = root.XamlRoot.RasterizationScale, photoCount = ViewModel.Photos.Count,
                    shellVisualMetadataFixture = ShellVisualMetadataFixture,
                    shellVisualSourceSidecarHash = _shellVisualSourceSidecarHash,
                    activeGroup = _activeGroup, comparison = _compare.ShowingBefore
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
            ResetComparison();
            _browseListDetail = originalBrowse;
            _infoPaneOpen = originalInfo;
            FilmstripRail.IsCollapsed = originalCollapsed;
            SetMode(originalMode);
            if (originalMode == ShellMode.Edit && originalGroup != _activeGroup)
            {
                CloseGroupPanel();
                if (originalGroup != null) ToggleGroupPanel(originalGroup);
            }
            UpdateBrowsePresentation();
            UpdateInfoPane();
            RestoreBrowseSelection(originalSelection, photo);
            AppWindow.Resize(originalSize);
            await Task.Delay(200);
            root.UpdateLayout();
        }
    }

    private async Task PrepareEditorVisualCheckpointAsync(string name)
    {
        _infoPaneOpen = false;
        SetMode(ShellMode.Edit);
        ResetZoom();
        var fitDeadline = Environment.TickCount64 + 5000;
        while (Math.Abs(ViewerScroll.ZoomFactor - 1) > .001 && Environment.TickCount64 < fitDeadline)
            await Task.Delay(50);
        if (Math.Abs(ViewerScroll.ZoomFactor - 1) > .001)
            throw new InvalidOperationException("Editor visual checkpoint did not reach Fit zoom.");
        var group = name switch
        {
            "editor-color" => "Color",
            "editor-crop" => "Crop",
            _ => "Light"
        };
        if (_activeGroup != group) ToggleGroupPanel(group);
        if (name != "editor-comparison") return;
        var before = Services.Xmp.XmpWriter.Serialize(
            new Services.Xmp.XmpSidecarDocument { Adjustments = ViewModel.Adjustments });
        await PrepareComparisonAsync();
        if (ComparisonImage.Source == null || _compareLoading)
            throw new InvalidOperationException("Editor visual comparison did not produce a real baseline frame.");
        OnCompareClick(CompareButton, new RoutedEventArgs());
        if (!_compare.ShowingBefore || ComparisonImage.Visibility != Visibility.Visible ||
            before != Services.Xmp.XmpWriter.Serialize(
                new Services.Xmp.XmpSidecarDocument { Adjustments = ViewModel.Adjustments }))
            throw new InvalidOperationException("Editor visual comparison is hidden or mutated the document.");
    }

    private async Task WaitForInspectorVisualReadyAsync()
    {
        var photo = ViewModel.SelectedPhoto
            ?? throw new InvalidOperationException("Inspector visual checkpoint has no photo.");
        var deadline = Environment.TickCount64 + 10000;
        while (!ReferenceEquals(photo, _metadataPhoto) || ExtraInfoRows.Children.Count == 0 ||
            ExtraInfoRows.Children.OfType<TextBlock>().Any(row => row.Text == "Loading metadata…"))
        {
            if (!ReferenceEquals(photo, ViewModel.SelectedPhoto) || _closing ||
                !_infoPaneOpen || _mode != ShellMode.Preview)
                throw new InvalidOperationException("Inspector visual hydration lost its photo or mode.");
            if (Environment.TickCount64 >= deadline)
                throw new TimeoutException("Inspector metadata did not settle before the visual checkpoint.");
            await Task.Delay(50);
        }
        if (ExtraInfoRows.Children.OfType<Maple.UI.Atoms.MuiButton>().Any())
            throw new InvalidOperationException("Inspector metadata failed; its retry state is not qualification evidence.");
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

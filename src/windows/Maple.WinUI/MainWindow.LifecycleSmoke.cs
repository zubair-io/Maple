using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private bool _lifecycleSmokeActive;
        private Action? _beforeRendererStopForSmoke;

        // Explicit diagnostic invocation only; no runtime setting or new env flag.
        internal void MaybeStartLifecycleSmoke()
        {
            var args = Environment.GetCommandLineArgs();
            var index = Array.IndexOf(args, "--lifecycle-smoke");
            if (index < 0) return;
            if (args.Length != index + 4 &&
                !(args.Length == index + 5 && args[^1] == "--visual-checkpoints"))
                throw new ArgumentException("--lifecycle-smoke RAW OUT gpu|cpu|empty [--visual-checkpoints]");
            _ = RunLifecycleSmokeAsync(args[index + 1], args[index + 2], args[index + 3]);
        }

        private async Task RunLifecycleSmokeAsync(string raw, string output, string expectedPath)
        {
            _lifecycleSmokeActive = true;
            Directory.CreateDirectory(output);
            var reportPath = Path.Combine(output, "lifecycle.json");
            try
            {
                var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
                if (hwnd == IntPtr.Zero || _panelNative == IntPtr.Zero)
                    throw new InvalidOperationException("Real HWND and QI'd panel required");
                var panel = _panelNative;
                RecordSmokeStage(output, "export-recipe-editor");
                VerifyExportRecipeEditor();
                // A scheduler disposed before receiving a native target/image
                // exercises partial initialization with its real loop.
                var unattached = new RenderScheduler();
                await unattached.StopAsync();
                await unattached.StopAsync();
                if (!unattached.IsStopped) throw new InvalidOperationException("Unattached scheduler did not stop");
                var renderer = ViewModel.Renderer;
                var frame = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                void Gpu(DecodedImage source, int w, int h, double ms, bool full) => frame.TrySetResult("gpu");
                void Cpu(DecodedImage source, byte[] px, int w, int h, uint[] bins, double ms) => frame.TrySetResult("cpu");
                renderer.GpuFrameReady += Gpu;
                renderer.FrameReady += Cpu;
                var actualPath = "empty";
                if (expectedPath != "empty")
                {
                    // The synthetic RAW has no embedded JPEG. Preview must
                    // render it without requiring the user to enter Edit.
                    SetMode(ShellMode.Preview);
                    ViewModel.SelectedPhoto = new PhotoItem
                    {
                        FilePath = raw,
                        FileName = Path.GetFileName(raw),
                        Format = "DNG"
                    };
                    var previewDeadline = Environment.TickCount64 + 90000;
                    while (!frame.Task.IsCompleted && ViewModel.SelectedPhoto.PreviewPath == null
                        && Environment.TickCount64 < previewDeadline) await Task.Delay(20);
                    // Embedded or developed derivatives do not start the live
                    // renderer. Exercise the actual Edit entry command.
                    if (ViewModel.SelectedPhoto.PreviewPath != null)
                        OnEnterEdit(this, new Microsoft.UI.Xaml.RoutedEventArgs());
                    try { actualPath = await frame.Task.WaitAsync(TimeSpan.FromSeconds(90)); }
                    catch (TimeoutException error)
                    {
                        throw new TimeoutException($"First frame missing: selected={ViewModel.SelectedPhoto?.FilePath}, "
                            + $"decoding={ViewModel.IsDecoding}, status={ViewModel.DecodeStatus}, "
                            + $"preview={ViewModel.SelectedPhoto?.PreviewPath}", error);
                    }
                    if (actualPath != expectedPath)
                        throw new InvalidOperationException($"Required {expectedPath} frame, got {actualPath}");
                    SetMode(ShellMode.Edit);
                }
                renderer.GpuFrameReady -= Gpu;
                renderer.FrameReady -= Cpu;
                if (expectedPath != "empty")
                {
                    RecordSmokeStage(output, "thumbnail-fallback");
                    await VerifyThumbnailFallbackAsync(raw, output);
                    RecordSmokeStage(output, "native-detail");
                    await VerifyNativeDetailAsync();
                    RecordSmokeStage(output, "scopes");
                    await VerifyScopesAsync();
                    RecordSmokeStage(output, "preset-undo");
                    await VerifyPresetUndoAsync();
                    RecordSmokeStage(output, "adjustment-gesture");
                    await VerifyAdjustmentGestureUndoAsync();
                    RecordSmokeStage(output, "retouch-undo");
                    // Repeat within one XAML lifetime: the intermittent repair
                    // failure was not covered by a single successful invocation.
                    for (var cycle = 0; cycle < 4; cycle++)
                    {
                        RecordSmokeStage(output, $"retouch-cycle-{cycle + 1}");
                        await VerifyRetouchUndoAsync(output);
                    }
                    RecordSmokeStage(output, "transfer-undo");
                    await VerifyTransferUndoAsync(output);
                    VerifyViewerDesignNavigation();
                    RecordSmokeStage(output, "filmstrip-metadata");
                    await VerifyFilmstripMetadataAsync();
                    RecordSmokeStage(output, "local-save-failure");
                    await VerifyLocalSaveFailureAsync(output);
                    RecordSmokeStage(output, "comparison");
                    await VerifyComparisonAsync(raw);
                    RecordSmokeStage(output, "film-comparison");
                    await VerifyFilmComparisonAsync(raw, output);
                    RecordSmokeStage(output, "responsive-layout");
                    await VerifyResponsiveDesignAsync();
                    await VerifyNativeWindowLayoutAsync(output);
                    RecordSmokeStage(output, "browse-selection");
                    VerifyBrowseSelection();
                    RecordSmokeStage(output, "browse-scrolling");
                    await VerifyBrowseScrollingAsync();
                    RecordSmokeStage(output, "browse-grouped-scrolling");
                    await VerifyBrowseScrollingAsync(grouped: true);
                    RecordSmokeStage(output, "immediate-undo");
                    await VerifyImmediateUndoAsync();
                    RecordSmokeStage(output, "preview-recovery");
                    await VerifyPreviewRecoveryAsync(raw, output);
                    RecordSmokeStage(output, "cloud-opening");
                    await EditSessionViewModel.VerifyCloudOpeningAsync(raw, output);
                    RecordSmokeStage(output, "cloud-search");
                    await EditSessionViewModel.VerifyCloudSearchAsync(output);
                    RecordSmokeStage(output, "cloud-map");
                    await VerifyCloudMapAsync(output);
                    RecordSmokeStage(output, "shutdown");
                }

                // Queue after asynchronous save preflight; otherwise the saving
                // dialog pumps this present before renderer shutdown starts.
                var queued = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                Exception? closingPresentError = null;
                void Queued() => queued.TrySetResult(true);
                if (expectedPath == "gpu")
                {
                    _beforeRendererStopForSmoke = () =>
                    {
                        renderer.PresentQueued += Queued;
                        try
                        {
                            renderer.RequestRender(ViewModel.Adjustments.Clone());
                            if (!renderer.HasPendingPresent && !queued.Task.Wait(TimeSpan.FromSeconds(5)))
                                throw new TimeoutException("No real GPU present queued after save preflight");
                        }
                        catch (Exception error) { closingPresentError = error; }
                        finally { renderer.PresentQueued -= Queued; }
                    };
                }
                Close();
                Close(); // repeated request before the dispatcher starts its drain
                var closeDeadline = Environment.TickCount64 + 30000;
                while (_shutdownTask == null && Environment.TickCount64 < closeDeadline) await Task.Delay(20);
                if (_shutdownTask == null) throw new TimeoutException("Close did not finish its save preflight");
                await ShutdownAsync();
                await ShutdownAsync();
                if (closingPresentError != null) throw closingPresentError;
                if (!renderer.IsStopped || _panelNative != IntPtr.Zero || _panelReleaseCount != 1)
                    throw new InvalidOperationException("Shutdown did not join/close/release exactly once");
                if (expectedPath == "gpu" && renderer.HasPendingPresent)
                    throw new InvalidOperationException("Queued present survived shutdown");
                if (expectedPath == "gpu" && renderer.DroppedClosingPresents < 1)
                    throw new InvalidOperationException("Shutdown did not reject the queued closing present");
                // Exercise a real late decoded result, after close has started.
                var late = await Task.Run(() => RenderEngine.Decode(raw, new AdjustmentState(), 256, RefineDecodeQuality.Preview, IntPtr.Zero));
                renderer.SetImage(late);
                renderer.SetPresentTarget(panel); // stale late attachment must be rejected
                renderer.RequestRender(new AdjustmentState());
                if (!renderer.IsStopped) throw new InvalidOperationException("Late producer reopened renderer");
                File.WriteAllText(reportPath, JsonSerializer.Serialize(new
                {
                    passed = true,
                    exportRecipeEditorRoundTrip = true,
                    hwnd = hwnd.ToInt64(),
                    renderPath = actualPath,
                    panelReleases = _panelReleaseCount,
                    rendererStopped = renderer.IsStopped,
                    droppedClosingPresents = renderer.DroppedClosingPresents,
                    viewerDesignNavigation = expectedPath != "empty",
                    localSaveFailureRecovery = expectedPath != "empty",
                    nativeDetailActualSize = expectedPath != "empty",
                    presetUndoRedoAndReset = expectedPath != "empty",
                    adjustmentGestureUndoRedo = expectedPath != "empty",
                    repairControlsUndoRedo = expectedPath != "empty",
                    scopesLifecycle = expectedPath != "empty",
                    transferWatcherUndoRedo = expectedPath != "empty",
                    comparisonPreservesDocument = expectedPath != "empty",
                    cloudOpeningReadiness = expectedPath != "empty",
                    cloudSearchPagination = expectedPath != "empty",
                    cloudMapHost = expectedPath != "empty",
                    responsiveDesign = expectedPath != "empty",
                    browseSelectionAndSort = expectedPath != "empty",
                    browseScrolling = expectedPath != "empty",
                    immediateUndo = expectedPath != "empty"
                }));
            }
            catch (Exception error)
            {
                Environment.ExitCode = 1;
                File.WriteAllText(reportPath, JsonSerializer.Serialize(new { passed = false, error = error.ToString() }));
            }
            finally
            {
                _beforeRendererStopForSmoke = null;
                await ShutdownAsync();
                _closeReady = true;
                Close(); // normal WinUI teardown; never Environment.Exit
            }
        }

        // Exercised by the real WinUI smoke, after a native frame is displayed.
        // Toggling presentation must preserve the document and inspector state.
        private void VerifyViewerDesignNavigation()
        {
            var photo = ViewModel.SelectedPhoto;
            var adjustments = ViewModel.Adjustments;
            if (photo != null && !ViewModel.Photos.Contains(photo)) ViewModel.Photos.Add(photo);
            SetMode(ShellMode.Preview);
            _infoPaneOpen = true;
            UpdateInfoPane();
            FilmstripRail.IsCollapsed = false;
            CanvasHost.UpdateLayout();
            FilmstripRail.IsCollapsed = true;
            CanvasHost.UpdateLayout();
            if (_mode != ShellMode.Preview || InfoPane.Visibility != Microsoft.UI.Xaml.Visibility.Visible ||
                !ReferenceEquals(photo, ViewModel.SelectedPhoto) || !ReferenceEquals(adjustments, ViewModel.Adjustments))
                throw new InvalidOperationException("Preview navigation changed the document or Info state");
            FilmstripRail.IsCollapsed = false;
            SetMode(ShellMode.Edit);
            if (_activeGroup != "Light" || PanelProfileHost.Visibility != Microsoft.UI.Xaml.Visibility.Visible ||
                PanelWhiteBalanceHost.Visibility != Microsoft.UI.Xaml.Visibility.Collapsed)
                throw new InvalidOperationException("Editor did not open Light with its profile selector");
            ToggleGroupPanel("Color");
            Content.UpdateLayout();
            foreach (var name in new[] { "Light", "Color" })
            {
                var content = (Microsoft.UI.Xaml.Controls.StackPanel)_railButtons[name].Content;
                var icon = content.Children.OfType<Maple.UI.Atoms.MuiIcon>().Single();
                var drawing = (Microsoft.UI.Xaml.Controls.Canvas)((Microsoft.UI.Xaml.Controls.Viewbox)icon.Content).Child;
                var stroke = drawing.Children.OfType<Microsoft.UI.Xaml.Shapes.Shape>().First().Stroke as Microsoft.UI.Xaml.Media.SolidColorBrush;
                var foreground = _railButtons[name].Foreground as Microsoft.UI.Xaml.Media.SolidColorBrush;
                if (stroke == null || foreground == null || stroke.Color != foreground.Color)
                    throw new InvalidOperationException($"{name} icon retained a stale selection color");
            }
            if (PanelWhiteBalanceHost.Visibility != Microsoft.UI.Xaml.Visibility.Visible ||
                PanelProfileHost.Visibility != Microsoft.UI.Xaml.Visibility.Collapsed)
                throw new InvalidOperationException("White balance and profile groups overlap");
            SetMode(ShellMode.Preview);
            if (FilmstripRail.IsCollapsed || InfoPane.Visibility != Microsoft.UI.Xaml.Visibility.Visible)
                throw new InvalidOperationException("Returning from Edit lost Preview layout state");
            SetMode(ShellMode.Edit);
        }

        private async Task VerifyComparisonAsync(string raw)
        {
            var original = await File.ReadAllBytesAsync(raw);
            var sidecar = Services.Xmp.SidecarStore.SidecarPathFor(raw);
            var before = File.Exists(sidecar) ? await File.ReadAllBytesAsync(sidecar) : null;
            var state = Services.Xmp.XmpWriter.Serialize(new Services.Xmp.XmpSidecarDocument { Adjustments = ViewModel.Adjustments });
            var undo = ViewModel.UndoCount;
            await PrepareComparisonAsync();
            if (ComparisonImage.Source == null) throw new InvalidOperationException("Comparison did not render");
            _compare.Toggle();
            UpdateComparison();
            if (ComparisonImage.Visibility != Microsoft.UI.Xaml.Visibility.Visible)
                throw new InvalidOperationException("Comparison did not become visible");
            ResetComparison();
            if (state != Services.Xmp.XmpWriter.Serialize(new Services.Xmp.XmpSidecarDocument { Adjustments = ViewModel.Adjustments }) || undo != ViewModel.UndoCount)
                throw new InvalidOperationException("Comparison changed live state or undo history");
            if (!original.SequenceEqual(await File.ReadAllBytesAsync(raw)) ||
                (before == null ? File.Exists(sidecar) : !before.SequenceEqual(await File.ReadAllBytesAsync(sidecar))))
                throw new InvalidOperationException("Comparison modified the original or sidecar");
        }

        private async Task VerifyResponsiveDesignAsync()
        {
            VerifyDragBarAccessibility();
            VerifyMaskSelection();
            var photo = ViewModel.SelectedPhoto;
            if (_activeGroup != "Light") ToggleGroupPanel("Light");
            Content.UpdateLayout();
            var slider = FindDescendant<Maple.UI.Atoms.MuiAdjustmentSlider>(EditPanel);
            if (slider == null || slider.ActualWidth <= 0 ||
                FindDescendant<Microsoft.UI.Xaml.Controls.Primitives.Thumb>(slider)?.Width != 12)
                throw new InvalidOperationException("Maple adjustment slider template was not realized");
            var peer = Microsoft.UI.Xaml.Automation.Peers.FrameworkElementAutomationPeer.CreatePeerForElement(slider);
            if (peer?.GetPattern(Microsoft.UI.Xaml.Automation.Peers.PatternInterface.RangeValue) == null)
                throw new InvalidOperationException("Adjustment slider lost native range accessibility");
            await VerifySliderGestureUndoAsync(slider);
            // Undo deliberately replaces the adjustment object. Capture the
            // identity after that check, before testing layout-only changes.
            var model = ViewModel.Adjustments;
            if (slider.ActualHeight > 24 || EditRailStack.Children.Count != 7 || CompareButton.IconName != "split" || CompareButton.Label.Length != 0)
                throw new InvalidOperationException("Editor density or primary tool dock differs from the design");
            if (FindDescendant<Microsoft.UI.Xaml.Controls.Border>(FilmstripRail)?.Background == null)
                throw new InvalidOperationException("Filmstrip is missing its shared surface");
            ToggleGroupPanel("Lens");
            if (PanelLensHost.Visibility != Microsoft.UI.Xaml.Visibility.Visible)
                throw new InvalidOperationException("Overflow lens tools are unavailable");
            ToggleGroupPanel("Geometry");
            if (PanelSliders.ItemsSource == null)
                throw new InvalidOperationException("Overflow geometry tools are unavailable");
            ToggleGroupPanel("Light");
            // DIP-equivalent content sizes cover the requested physical sizes
            // at 100/150/200% without changing the user's desktop DPI setting.
            var root = (Microsoft.UI.Xaml.FrameworkElement)Content;
            foreach (var size in new[] { (1440d, 900d), (1024d, 768d), (960d, 600d), (683d, 512d), (720d, 450d), (512d, 384d) })
            {
                root.Width = size.Item1;
                root.Height = size.Item2;
                root.UpdateLayout();
                await Task.Delay(30);
                root.UpdateLayout();
                VerifyEditorHeaderBounds();
                if (ContentFitRect() is { } imageBounds &&
                    (imageBounds.X < -.5 || imageBounds.Y < -.5 || imageBounds.X + imageBounds.W > ZoomHost.ActualWidth + .5 ||
                     imageBounds.Y + imageBounds.H > ZoomHost.ActualHeight + .5))
                    throw new InvalidOperationException($"Photo is clipped at fit zoom at {size}");
                if (ViewportSwapChainPanel.Visibility == Microsoft.UI.Xaml.Visibility.Visible)
                {
                    var displayed = ViewportSwapChainPanel.TransformToVisual(ZoomHost).TransformBounds(
                        new Windows.Foundation.Rect(0, 0, ViewportSwapChainPanel.ActualWidth, ViewportSwapChainPanel.ActualHeight));
                    if (displayed.Left < -.5 || displayed.Top < -.5 || displayed.Right > ZoomHost.ActualWidth + .5 || displayed.Bottom > ZoomHost.ActualHeight + .5)
                        throw new InvalidOperationException($"GPU surface exceeds fitted viewport at {size}");
                }
                var buttonBounds = CompareButton.TransformToVisual(root).TransformBounds(new Windows.Foundation.Rect(0, 0, CompareButton.ActualWidth, CompareButton.ActualHeight));
                var histogramBounds = HeaderHistogram.TransformToVisual(EditTopBar).TransformBounds(
                    new Windows.Foundation.Rect(0, 0, HeaderHistogram.ActualWidth, HeaderHistogram.ActualHeight));
                if (HeaderHistogram.Visibility != Microsoft.UI.Xaml.Visibility.Visible || HeaderHistogram.ActualWidth < 96 ||
                    histogramBounds.Left < 0 || histogramBounds.Right > EditTopBar.ActualWidth ||
                    histogramBounds.Top < 0 || histogramBounds.Bottom > EditTopBar.ActualHeight)
                    throw new InvalidOperationException($"Header histogram is hidden or clipped at {size}");
                if (buttonBounds.Right > size.Item1 || buttonBounds.Left < 0 || EditPanel.ActualHeight > size.Item2 ||
                    EditPanel.Visibility != Microsoft.UI.Xaml.Visibility.Visible || EditPanel.ActualHeight <= 0)
                    throw new InvalidOperationException($"Editor chrome overflow at {size}");
                SetMode(ShellMode.Preview);
                _infoPaneOpen = true;
                UpdateInfoPane();
                root.UpdateLayout();
                if (InfoPane.ActualWidth < 280 || InfoPane.ActualWidth > size.Item1)
                    throw new InvalidOperationException($"Info overflow at {size}");
                SetMode(ShellMode.Edit);
            }
            root.Width = root.Height = double.NaN;
            root.UpdateLayout();
            if (!ReferenceEquals(photo, ViewModel.SelectedPhoto) || !ReferenceEquals(model, ViewModel.Adjustments))
                throw new InvalidOperationException("Responsive layout replaced the document");
        }

        private void VerifyBrowseSelection()
        {
            var photo = ViewModel.SelectedPhoto!;
            var originalPhotos = ViewModel.AllPhotos.ToArray();
            var originalSort = ViewModel.PhotoSort;
            var originalView = _browseListDetail;
            var second = new PhotoItem { FilePath = photo.FilePath + ".second", FileName = "Second.dng", Rating = 5 };
            SetMode(ShellMode.Browse);
            ViewModel.AllPhotos.Clear();
            ViewModel.AllPhotos.Add(photo);
            ViewModel.AllPhotos.Add(second);
            try
            {
                foreach (var sort in Enum.GetValues<BrowseSort>())
                {
                    _syncingBrowseSelection = true;
                    try { ViewModel.PhotoSort = sort; ViewModel.ApplyFilters(); }
                    finally { _syncingBrowseSelection = false; }
                    RestoreBrowseSelection(new[] { photo, second }, photo);
                    _browseListDetail = !_browseListDetail;
                    UpdateBrowsePresentation();
                    Content.UpdateLayout();
                    if (ViewModel.SelectedPhotos.Count != 2 || BrowsePhotoList.SelectedItems.Count != 2 ||
                        PhotoGrid.SelectedItems.Count != 2 || !ReferenceEquals(ViewModel.SelectedPhoto, photo) ||
                        !ViewModel.Photos.SequenceEqual(BrowseSortLogic.Order(new[] { photo, second }, sort)))
                        throw new InvalidOperationException($"Browse selection/order changed for {sort}");
                }
            }
            finally
            {
                ViewModel.AllPhotos.Clear();
                foreach (var item in originalPhotos) ViewModel.AllPhotos.Add(item);
                if (!ViewModel.AllPhotos.Contains(photo)) ViewModel.AllPhotos.Add(photo);
                _syncingBrowseSelection = true;
                try { ViewModel.PhotoSort = originalSort; ViewModel.ApplyFilters(); }
                finally { _syncingBrowseSelection = false; }
                _browseListDetail = originalView;
                UpdateBrowsePresentation();
                RestoreBrowseSelection(new[] { photo }, photo);
                SetMode(ShellMode.Edit);
            }
        }

        private async Task VerifyImmediateUndoAsync()
        {
            var exposure = ViewModel.Adjustments.Exposure;
            var depth = ViewModel.UndoCount;
            ViewModel.Adjustments.Exposure = exposure + .25;
            ViewModel.NotifyAdjustmentEdited();
            ViewModel.Undo(); // before the 450ms gesture boundary
            await Task.Delay(550);
            if (ViewModel.Adjustments.Exposure != exposure || ViewModel.UndoCount != depth)
                throw new InvalidOperationException("Immediate Undo lost the edit or queued another boundary");
        }
    }
}

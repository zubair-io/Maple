using System;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.System;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>Shell navigation follows the product's three-stage flow:
    /// Browse (grid) → Preview (full image + filmstrip + culling) → Edit
    /// (full-bleed canvas with the floating tool rail and group panels).
    /// Sliders exist only in Edit.</summary>
    public enum ShellMode { Browse, Preview, Edit }

    public sealed partial class MainWindow : Window
    {
        public EditSessionViewModel ViewModel { get; }

        private WriteableBitmap? _viewportBitmap;
        private readonly AppSettings _settings = AppSettings.Load();
        private ShellMode _mode = ShellMode.Browse;
        private uint[]? _lastHistogramBins;
        private IntPtr _panelNative;
        private (int Width, int Height)? _gpuFrameDims;

        /// <summary>WinUI 3 DXInterop ISwapChainPanelNative IID — the interface
        /// wgpu's DX12 surface QIs SetSwapChain through.</summary>
        private static Guid _swapChainPanelNativeIid =
            new("63AAD0B8-7C24-40FF-85A8-640D944CC325");

        public MainWindow()
        {
            ViewModel = new EditSessionViewModel();
            this.InitializeComponent();

            if (this.Content is FrameworkElement root)
            {
                root.DataContext = ViewModel;
                root.KeyDown += OnRootKeyDown;
                WireDropTarget(root);   // OS file/folder drops (#2651) — MainWindow.DropMount.cs
            }

            ViewModel.Renderer.FrameReady += OnFrameReady;
            ViewModel.Renderer.GpuFrameReady += OnGpuFrameReady;
            ViewModel.Renderer.ClipSourceReady += OnClipSourceReady;
            ViewModel.Renderer.HistogramReady += bins =>
                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    _lastHistogramBins = bins;
                    HistogramView.Draw(HistogramCanvas, bins);
                    UpdateCurveHistogram();
                    UpdateClipIndicators();
                });
            ViewModel.Renderer.GpuUnavailable += reason =>
            {
                System.Diagnostics.Debug.WriteLine($"[Gpu] downgraded to CPU path: {reason}");
                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    ViewportSwapChainPanel.Visibility = Visibility.Collapsed;
                    ViewportImage.Visibility = Visibility.Visible;
                });
            };
            ViewModel.Renderer.RenderFailed += message =>
                App.MainDispatcherQueue?.TryEnqueue(() => RenderStatsText.Text = $"render error: {message}");

            // Hand the DX12 present target to the render loop. QI once; the
            // panel outlives the scheduler (window lifetime).
            var panelUnknown = ((WinRT.IWinRTObject)ViewportSwapChainPanel).NativeObject.ThisPtr;
            if (System.Runtime.InteropServices.Marshal.QueryInterface(
                    panelUnknown, ref _swapChainPanelNativeIid, out _panelNative) == 0)
            {
                ViewModel.Renderer.SetPresentTarget(_panelNative);
            }
            ViewportSwapChainPanel.CompositionScaleChanged += (_, _) =>
                ViewModel.Renderer.BumpSurfaceGeneration();
            ViewModel.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(ViewModel.SelectedPhoto))
                    OnSelectedPhotoChanged();
                else if (e.PropertyName == nameof(ViewModel.SelectionSummary))
                    UpdateLibraryCountText();
            };
            ViewModel.Photos.CollectionChanged += (_, _) =>
            {
                UpdateLibraryCountText();
                EmptyStateText.Visibility =
                    ViewModel.Photos.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            };

            // Title-bar / taskbar icon (the exe icon covers Explorer; unpackaged
            // windows need the runtime SetIcon too).
            this.AppWindow.SetIcon(System.IO.Path.Combine(
                AppContext.BaseDirectory, "Assets", "maple.ico"));

            SidebarColDef.Width = new GridLength(_settings.LeftPanelHidden ? 0 : _settings.LeftPanelWidth);
            PhotoGrid.PreviewKeyDown += (_, e) =>
            {
                // Tunnels from the grid down to whatever's focused —
                // including a cell's inline-rename TextBox (#2639). Without
                // this guard, pressing Enter to commit a rename would be
                // intercepted here first and open Preview instead; the
                // TextBox's own KeyDown handler (OnRenameTextBoxKeyDown)
                // never gets Enter once Handled is set during the tunnel
                // pass. Same guard OnRootKeyDown already uses for the same
                // reason.
                if (e.Key == VirtualKey.Enter
                    && FocusManager.GetFocusedElement(this.Content.XamlRoot) is not TextBox)
                {
                    EnterPreview();
                    e.Handled = true;
                }
            };
            BuildStarRow();
            BuildEditRail();
            BuildGradePanel();
            BuildCropPanel();
            MaybeStartQualifyRun();
            CurvePlot.PointsChanged += OnCurvePointsChanged;
            ViewModel.ModelSynced += () =>
            {
                SyncGradeWheels();
                if (_activeGroup == "Tone Curve")
                    RefreshCurvePlot();
                SyncCropFromModel();
            };
            HookViewerPan();
            // Wire the grouped grid source only after the chrome exists —
            // setting Source synchronously raises the grid's first selection.
            ((Microsoft.UI.Xaml.Data.CollectionViewSource)
                ((FrameworkElement)Content).Resources["GroupedPhotosSource"]).Source = ViewModel.PhotoGroups;
            SetMode(ShellMode.Browse);
            this.Closed += (_, _) => ViewModel.Dispose();
        }

        // --- Mode state machine ---

        private void SetMode(ShellMode mode)
        {
            _mode = mode;
            var browse = mode == ShellMode.Browse;
            var edit = mode == ShellMode.Edit;

            SidebarPane.Visibility = browse ? Visibility.Visible : Visibility.Collapsed;
            SidebarColDef.Width = browse
                ? new GridLength(_settings.LeftPanelHidden ? 0 : _settings.LeftPanelWidth)
                : new GridLength(0);

            BrowseGridContainer.Visibility = browse ? Visibility.Visible : Visibility.Collapsed;
            ViewerContainer.Visibility = browse ? Visibility.Collapsed : Visibility.Visible;

            PreviewTopBar.Visibility = mode == ShellMode.Preview ? Visibility.Visible : Visibility.Collapsed;
            FilmstripBar.Visibility = mode == ShellMode.Preview ? Visibility.Visible : Visibility.Collapsed;
            EditTopBar.Visibility = edit ? Visibility.Visible : Visibility.Collapsed;
            EditRail.Visibility = edit ? Visibility.Visible : Visibility.Collapsed;
            if (!edit)
            {
                CloseGroupPanel();
                return;
            }
            // The histogram canvas has zero size until the pill first lays out,
            // so replay the newest bins once the layout pass completes.
            HistogramCanvas.DispatcherQueue.TryEnqueue(() =>
            {
                if (_lastHistogramBins != null)
                    HistogramView.Draw(HistogramCanvas, _lastHistogramBins);
            });
        }

        /// <summary>Enters Preview targeting a single, well-defined photo even
        /// when the grid has a multi-selection. See
        /// EditSessionViewModel.ResolvePrimaryTarget for the fallback order.</summary>
        private void EnterPreview()
        {
            var target = EditSessionViewModel.ResolvePrimaryTarget(
                ViewModel.SelectedPhotos, ViewModel.SelectedPhoto, ViewModel.Photos);
            if (target != null)
                ViewModel.SelectedPhoto = target;
            if (ViewModel.SelectedPhoto != null)
                SetMode(ShellMode.Preview);
        }

        private void OnViewerBack(object sender, RoutedEventArgs e) => SetMode(ShellMode.Browse);

        private void OnEnterEdit(object sender, RoutedEventArgs e)
        {
            SetMode(ShellMode.Edit);
            ViewModel.EnsureDecoded();
        }

        private void OnExitEdit(object sender, RoutedEventArgs e) => SetMode(ShellMode.Preview);

        // --- Rendering ---

        private void OnGpuFrameReady(int width, int height, double millis, bool fullRes)
        {
            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                // Both phases present into ONE surface pinned at the full
                // session dims (#2587) — the half-res fast pass is upscaled in
                // the present shader — so the panel size never changes between
                // fast and refined frames. Re-fit only when the dims actually
                // change (a new image/session), not on every drag tick.
                if (_gpuFrameDims != (width, height))
                {
                    _gpuFrameDims = (width, height);
                    UpdatePanelFit();
                }
                ViewportSwapChainPanel.Visibility = Visibility.Visible;
                ViewportImage.Visibility = Visibility.Collapsed;
                RenderStatsText.Text =
                    $"{width}×{height} · GPU {millis:0} ms{(fullRes ? string.Empty : " (fast)")}";
                ViewModel.LastRenderMillis = millis;
            });
        }

        /// <summary>Size the SwapChainPanel to exactly the session dims in DIPs:
        /// a SwapChainPanel composites its swapchain at 1 buffer pixel = 1 DIP
        /// (no stretch-to-element), so any other element size leaves bands or
        /// crops. Fit-to-viewport is achieved by choosing the decode size, not
        /// by scaling the panel.</summary>
        private void UpdatePanelFit()
        {
            if (_gpuFrameDims is not { } dims)
                return;
            ViewportSwapChainPanel.Width = dims.Width;
            ViewportSwapChainPanel.Height = dims.Height;
            SizeZoomHost();
            UpdateCropDisplay();
        }

        private void OnCanvasHostSizeChanged(object sender, SizeChangedEventArgs e)
        {
            UpdatePanelFit();
            SizeZoomHost();
            UpdateCropDisplay();
        }

        // --- Zoom / pan (#2572): factor 1 = fit; drag pans when zoomed ---

        private bool _panning;
        private Windows.Foundation.Point _panStart;
        private (double H, double V) _panStartOffsets;

        /// <summary>The zoom host tracks the scroll viewport at factor 1, so
        /// "fit" is always zoomFactor 1 regardless of window size.</summary>
        private void SizeZoomHost()
        {
            var width = ViewerScroll.ViewportWidth;
            var height = ViewerScroll.ViewportHeight;
            if (width > 0 && height > 0)
            {
                ZoomHost.Width = width;
                ZoomHost.Height = height;
            }
        }

        private void ResetZoom() =>
            ViewerScroll.ChangeView(0, 0, 1.0f, disableAnimation: true);

        /// <summary>1:1 = one content pixel (GPU session, rendered frame, or
        /// embedded-preview JPEG) per physical screen pixel.</summary>
        private float OneToOneZoomFactor()
        {
            double contentPixels = _gpuFrameDims?.Width
                ?? _viewportBitmap?.PixelWidth
                ?? (ViewportImage.Source as Microsoft.UI.Xaml.Media.Imaging.BitmapImage)?.PixelWidth
                ?? 0;
            var displayedDips = _gpuFrameDims is { } dims
                ? dims.Width
                : ViewportImage.ActualWidth;
            var rasterScale = ViewportSwapChainPanel.CompositionScaleX is > 0 and var s ? s : 1.0;
            if (contentPixels <= 0 || displayedDips <= 0)
                return 1f;
            // Content pixels per displayed DIP at zoom 1, corrected to physical.
            return (float)Math.Clamp(contentPixels / (displayedDips * rasterScale), 0.4, 8.0);
        }

        private void SetZoom(float factor, Windows.Foundation.Point? focus = null)
        {
            factor = Math.Clamp(factor, (float)ViewerScroll.MinZoomFactor, (float)ViewerScroll.MaxZoomFactor);
            var current = ViewerScroll.ZoomFactor;
            if (Math.Abs(factor - current) < 0.001f)
                return;
            // Keep the focus point (content coords) stationary in the viewport.
            var focusContent = focus ?? new Windows.Foundation.Point(
                (ViewerScroll.HorizontalOffset + ViewerScroll.ViewportWidth / 2) / current,
                (ViewerScroll.VerticalOffset + ViewerScroll.ViewportHeight / 2) / current);
            var offsetX = focusContent.X * factor - ViewerScroll.ViewportWidth / 2;
            var offsetY = focusContent.Y * factor - ViewerScroll.ViewportHeight / 2;
            ViewerScroll.ChangeView(Math.Max(0, offsetX), Math.Max(0, offsetY), factor,
                disableAnimation: false);
        }

        private void OnViewerDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            var position = e.GetPosition(ZoomHost);
            SetZoom(ViewerScroll.ZoomFactor > 1.01f ? 1f : OneToOneZoomFactor(), position);
            e.Handled = true;
        }

        private void HookViewerPan()
        {
            ZoomHost.PointerPressed += (_, e) =>
            {
                if (ViewerScroll.ZoomFactor <= 1.01f)
                    return;
                _panning = true;
                _panStart = e.GetCurrentPoint(this.Content).Position;
                _panStartOffsets = (ViewerScroll.HorizontalOffset, ViewerScroll.VerticalOffset);
                ZoomHost.CapturePointer(e.Pointer);
            };
            ZoomHost.PointerMoved += (_, e) =>
            {
                if (!_panning)
                    return;
                var position = e.GetCurrentPoint(this.Content).Position;
                ViewerScroll.ChangeView(
                    _panStartOffsets.H - (position.X - _panStart.X),
                    _panStartOffsets.V - (position.Y - _panStart.Y),
                    null, disableAnimation: true);
            };
            ZoomHost.PointerReleased += (_, e) =>
            {
                _panning = false;
                ZoomHost.ReleasePointerCapture(e.Pointer);
            };
            ZoomHost.PointerCanceled += (_, _) => _panning = false;
        }

        private void OnFrameReady(byte[] bgra, int width, int height, uint[] bins, double millis)
        {
            var copy = new byte[bgra.Length];
            Buffer.BlockCopy(bgra, 0, copy, 0, bgra.Length);
            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                ViewportSwapChainPanel.Visibility = Visibility.Collapsed;
                ViewportImage.Visibility = Visibility.Visible;
                if (_viewportBitmap == null || _viewportBitmap.PixelWidth != width
                    || _viewportBitmap.PixelHeight != height)
                {
                    _viewportBitmap = new WriteableBitmap(width, height);
                    ViewportImage.Source = _viewportBitmap;
                }
                using (var stream = _viewportBitmap.PixelBuffer.AsStream())
                {
                    stream.Write(copy, 0, copy.Length);
                }
                _viewportBitmap.Invalidate();
                RenderStatsText.Text = $"{millis:0} ms";
                ViewModel.LastRenderMillis = millis;
                _lastHistogramBins = bins;
                HistogramView.Draw(HistogramCanvas, bins);
                UpdateCurveHistogram();
                UpdateClipIndicators();
            });
        }

        // --- Browse chrome ---

        private void OnToggleSidebar(object sender, RoutedEventArgs e)
        {
            var hidden = SidebarColDef.Width.Value > 0;
            SidebarColDef.Width = new GridLength(hidden ? 0 : Math.Max(_settings.LeftPanelWidth, 200));
            _settings.LeftPanelHidden = hidden;
            _settings.Save();
        }

        // --- Selection ---
        // PhotoGrid's own SelectionChanged (Extended mode, multi-select) is
        // OnPhotoGridSelectionChanged in MainWindow.Selection.cs.

        private void OnGridDoubleTapped(object sender, DoubleTappedRoutedEventArgs e) => EnterPreview();

        // Stays for the Filmstrip, which is single-select (one photo at a
        // time while paging through Preview).
        private void OnGridSelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (sender is ListViewBase list && list.SelectedItem is PhotoItem photo
                && !ReferenceEquals(photo, ViewModel.SelectedPhoto))
            {
                ViewModel.SelectedPhoto = photo;
            }
        }

        private PhotoItem? _previewSubscribed;

        private void OnSelectedPhotoChanged()
        {
            var photo = ViewModel.SelectedPhoto;
            if (photo == null)
                return;
            if (PhotoGrid.SelectedItem != photo)
                PhotoGrid.SelectedItem = photo;
            if (Filmstrip.SelectedItem != photo)
            {
                Filmstrip.SelectedItem = photo;
                Filmstrip.ScrollIntoView(photo);
            }
            UpdateStarRow();

            // The viewer shows the embedded JPEG until the Edit decode delivers
            // its first chain frame (the spec's placeholder-then-crossfade).
            _viewportBitmap = null;
            _gpuFrameDims = null;
            ViewportSwapChainPanel.Visibility = Visibility.Collapsed;
            ViewportImage.Visibility = Visibility.Visible;
            ResetZoom();  // zoom is per-image and resets on navigation (spec)
            // A stale clipping overlay must never sit over the next photo.
            ClipOverlayImage.Visibility = Visibility.Collapsed;
            ShowEmbeddedPreview(photo);
            if (_previewSubscribed != null)
                _previewSubscribed.PropertyChanged -= OnCurrentPhotoPropertyChanged;
            _previewSubscribed = photo;
            photo.PropertyChanged += OnCurrentPhotoPropertyChanged;

            if (_mode == ShellMode.Edit)
                ViewModel.EnsureDecoded();
        }

        private void OnCurrentPhotoPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
        {
            if (e.PropertyName is not (nameof(PhotoItem.PreviewPath) or nameof(PhotoItem.ThumbnailPath)))
                return;
            var photo = ViewModel.SelectedPhoto;
            // Only refresh while the embedded preview is still what's on screen.
            if (photo != null && ReferenceEquals(sender, photo) && _viewportBitmap == null)
                ShowEmbeddedPreview(photo);
        }

        private void ShowEmbeddedPreview(PhotoItem photo)
        {
            var source = photo.PreviewPath ?? photo.ThumbnailPath;
            ViewportImage.Source = source != null
                ? new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(new Uri(source))
                : null;
        }

        // --- Library scopes / filters ---

        private void OnSelectLibraryScope(object sender, SelectionChangedEventArgs e)
        {
            if (LibraryList.SelectedItem is not ListViewItem item)
                return;
            var scope = item.Tag as string;
            ViewModel.SetDateFilter(null, null);
            ViewModel.FlagFilter = scope is "pick" or "reject" ? scope : "all";
            ViewModel.MinRatingFilter = scope == "rated4" ? 4 : 0;
        }

        private void OnFolderNodeInvoked(TreeView sender, TreeViewItemInvokedEventArgs args)
        {
            if (args.InvokedItem is FolderNode { IsPlaceholder: false, IsUnavailable: false } node)
            {
                ViewModel.SetDateFilter(null, null);
                ViewModel.LoadDirectory(node.Path);
                SetMode(ShellMode.Browse);
            }
        }

        private void OnFolderExpanding(TreeView sender, TreeViewExpandingEventArgs args)
        {
            if (args.Item is FolderNode node)
                ViewModel.LoadFolderChildren(node);
        }

        private async void OnRemoveFolder(object sender, RoutedEventArgs e)
        {
            if ((sender as FrameworkElement)?.DataContext is not FolderNode node)
                return;
            if (!ViewModel.IsLibraryRoot(node.Path))
            {
                await ShowMessageAsync("Folders",
                    "Only top-level library folders can be removed — subfolders are part "
                    + "of their library root.");
                return;
            }
            // Unregisters only; nothing on disk (originals, sidecars) is touched.
            ViewModel.RemoveLibraryFolder(node.Path);
        }

        private void OnTimelineNodeInvoked(TreeView sender, TreeViewItemInvokedEventArgs args)
        {
            if (args.InvokedItem is TimelineNode node)
            {
                ViewModel.SetDateFilter(node.PeriodStart, node.PeriodEndExclusive);
                SetMode(ShellMode.Browse);
            }
        }

        private void OnClearTimelineFilter(object sender, RoutedEventArgs e) =>
            ViewModel.SetDateFilter(null, null);

        private void OnFormatFilterChanged(object sender, SelectionChangedEventArgs e)
        {
            if (FormatFilterBox.SelectedItem is ComboBoxItem item && item.Tag is string tag)
                ViewModel.FormatFilter = tag;
        }

        private void OnRatingFilterChanged(object sender, SelectionChangedEventArgs e)
        {
            if (RatingFilterBox.SelectedItem is ComboBoxItem item && item.Tag is string tag)
                ViewModel.MinRatingFilter = int.Parse(tag);
        }

        private void OnSearchChanged(object sender, TextChangedEventArgs e) =>
            ViewModel.SearchText = SearchBox.Text;

        // --- Edit actions ---

        private void OnSliderRowDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            if (sender is FrameworkElement { DataContext: AdjustmentSliderViewModel slider })
                slider.Reset();
        }

        private void OnApplyAuto(object sender, RoutedEventArgs e) => ViewModel.ApplyAuto();
        private void OnResetAll(object sender, RoutedEventArgs e) => ViewModel.ResetToDefaults();
        private void OnRevert(object sender, RoutedEventArgs e) => ViewModel.RevertToOriginal();

        // --- Culling ---

        private void OnFlagPick(object sender, RoutedEventArgs e) => ViewModel.SetFlag("pick");
        private void OnFlagReject(object sender, RoutedEventArgs e) => ViewModel.SetFlag("reject");

        // --- Keyboard (culling + navigation + edit) ---

        private void OnRootKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (FocusManager.GetFocusedElement(this.Content.XamlRoot) is TextBox)
                return;
            var ctrl = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            var shift = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);

            var key = (int)e.Key;
            if (!ctrl && key >= (int)VirtualKey.Number0 && key <= (int)VirtualKey.Number5)
            {
                ViewModel.SetRating(key - (int)VirtualKey.Number0);
                UpdateStarRow();
                e.Handled = true;
                return;
            }

            e.Handled = true;
            switch (e.Key)
            {
                case VirtualKey.P when !ctrl: ViewModel.SetFlag("pick"); break;
                case VirtualKey.X when !ctrl: ViewModel.SetFlag("reject"); break;
                case VirtualKey.U when !ctrl: ViewModel.SetFlag("none"); break;
                case VirtualKey.Left: ViewModel.SelectNeighbor(-1); break;
                case VirtualKey.Right: ViewModel.SelectNeighbor(1); break;
                case VirtualKey.Up when _mode != ShellMode.Browse: ViewModel.SelectNeighbor(-10); break;
                case VirtualKey.Down when _mode != ShellMode.Browse: ViewModel.SelectNeighbor(10); break;
                case VirtualKey.Enter when _mode == ShellMode.Browse: EnterPreview(); break;
                // ListViewBase.SelectAll — valid because PhotoGrid is
                // SelectionMode="Extended" (it throws only in Single/None).
                case VirtualKey.A when ctrl && _mode == ShellMode.Browse: PhotoGrid.SelectAll(); break;
                // Inline rename (#2639): same "sole selection, else resolved
                // primary target" rule Enter uses to open a photo — see
                // ResolveRenameTarget's doc comment.
                case VirtualKey.F2 when _mode == ShellMode.Browse:
                    if (ViewModel.ResolveRenameTarget() is { } renameTarget)
                        StartRename(renameTarget);
                    break;
                // Delete → Trash (#2654): same OnDeleteSelectedPhotos entry
                // point as the Photo menu's "Delete…" item and the grid's
                // right-click ContextFlyout. Fire-and-forget from a
                // synchronous key handler, same shape as every other
                // async-dialog entry point reachable from this switch.
                case VirtualKey.Delete when _mode == ShellMode.Browse:
                    _ = RunDeleteSelectedPhotosAsync();
                    break;
                case VirtualKey.E when !ctrl && _mode == ShellMode.Preview:
                    SetMode(ShellMode.Edit);
                    ViewModel.EnsureDecoded();
                    break;
                case VirtualKey.Escape when _mode == ShellMode.Edit: SetMode(ShellMode.Preview); break;
                case VirtualKey.Escape when _mode == ShellMode.Preview: SetMode(ShellMode.Browse); break;
                case VirtualKey.Number0 when ctrl && _mode != ShellMode.Browse:
                    ResetZoom();
                    break;
                case VirtualKey.Number1 when ctrl && _mode != ShellMode.Browse:
                    SetZoom(OneToOneZoomFactor());
                    break;
                case (VirtualKey)0xBB when ctrl && _mode != ShellMode.Browse:  // '=' / '+'
                    SetZoom(ViewerScroll.ZoomFactor * 1.5f);
                    break;
                case (VirtualKey)0xBD when ctrl && _mode != ShellMode.Browse:  // '-'
                    SetZoom(ViewerScroll.ZoomFactor / 1.5f);
                    break;
                case VirtualKey.Z when ctrl && shift: ViewModel.Redo(); break;
                case VirtualKey.Z when ctrl: ViewModel.Undo(); break;
                case VirtualKey.R when ctrl: ViewModel.RevertToOriginal(); break;
                case VirtualKey.E when ctrl: OnExportPhotos(this, new RoutedEventArgs()); break;
                case VirtualKey.O when ctrl: OnOpenDirectory(this, new RoutedEventArgs()); break;
                default: e.Handled = false; break;
            }
        }

        // --- Clipping overlay (#2574) ---

        private bool _clipShadowOn;
        private bool _clipHighlightOn;
        private WriteableBitmap? _clipOverlayBitmap;
        private byte[]? _clipOverlayScratch;   // reused per frame — no per-tick allocation

        private void OnToggleShadowClip(object sender, RoutedEventArgs e)
        {
            _clipShadowOn = !_clipShadowOn;
            ApplyClipToggles();
        }

        private void OnToggleHighlightClip(object sender, RoutedEventArgs e)
        {
            _clipHighlightOn = !_clipHighlightOn;
            ApplyClipToggles();
        }

        private void ApplyClipToggles()
        {
            ViewModel.Renderer.ClipOverlayEnabled = _clipShadowOn || _clipHighlightOn;
            if (!ViewModel.Renderer.ClipOverlayEnabled)
                ClipOverlayImage.Visibility = Visibility.Collapsed;
            UpdateClipIndicators();
            // Kick one tick so the overlay (dis)appears without waiting for
            // the next slider edit.
            ViewModel.Renderer.RequestRender(ViewModel.Adjustments.Clone());
        }

        /// <summary>Indicator dots: lit in the clip color once a channel clips
        /// more than 0.1% of pixels (a lone specular pixel shouldn't glow);
        /// brighter when its overlay toggle is armed.</summary>
        private void UpdateClipIndicators()
        {
            if (_lastHistogramBins is not { Length: >= 768 } bins)
                return;
            long total = 0;
            for (var i = 0; i < 256; i++)
                total += bins[i];
            var threshold = (uint)Math.Max(1, total / 1000);
            // Same 254/1 tolerance band as the overlay: AgX's shoulder plus
            // the display dither rarely land on exactly 255/0.
            var shadowClips = ClipBandCount(bins, 0) > threshold;
            var highlightClips = ClipBandCount(bins, 254) > threshold;
            var muted = (Microsoft.UI.Xaml.Media.SolidColorBrush)
                Application.Current.Resources["MapleBorderHi"];
            var armed = new Microsoft.UI.Xaml.Media.SolidColorBrush(
                Windows.UI.Color.FromArgb(255, 0xF2, 0xEF, 0xE9));
            ShadowClipDot.Fill = shadowClips
                ? new Microsoft.UI.Xaml.Media.SolidColorBrush(
                    Windows.UI.Color.FromArgb(255, 0x4F, 0x7F, 0xC4))
                : muted;
            HighlightClipDot.Fill = highlightClips
                ? new Microsoft.UI.Xaml.Media.SolidColorBrush(
                    Windows.UI.Color.FromArgb(255, 0xD1, 0x58, 0x4A))
                : muted;
            // The armed overlay toggle reads as a ring around the dot.
            ShadowClipDot.Stroke = _clipShadowOn ? armed : null;
            ShadowClipDot.StrokeThickness = 1;
            HighlightClipDot.Stroke = _clipHighlightOn ? armed : null;
            HighlightClipDot.StrokeThickness = 1;
        }

        /// <summary>Pixels in the two-bin clip band starting at binStart, summed
        /// over R/G/B (bins are channel-major, 256 per channel).</summary>
        private static uint ClipBandCount(uint[] bins, int binStart)
        {
            uint count = 0;
            for (var channel = 0; channel < 3; channel++)
                for (var offset = 0; offset < 2; offset++)
                    count += bins[channel * 256 + binStart + offset];
            return count;
        }

        /// <summary>Paint the overlay: opaque red where any channel is blown
        /// (255), opaque blue where all three are crushed (0), transparent
        /// elsewhere — the Lightroom-style J-overlay semantics.</summary>
        private void OnClipSourceReady(byte[] bgra, int width, int height)
        {
            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                if (!ViewModel.Renderer.ClipOverlayEnabled)
                    return;
                if (_clipOverlayBitmap == null || _clipOverlayBitmap.PixelWidth != width
                    || _clipOverlayBitmap.PixelHeight != height)
                {
                    _clipOverlayBitmap = new WriteableBitmap(width, height);
                    ClipOverlayImage.Source = _clipOverlayBitmap;
                }
                if (_clipOverlayScratch == null || _clipOverlayScratch.Length != bgra.Length)
                    _clipOverlayScratch = new byte[bgra.Length];
                var overlay = _clipOverlayScratch;
                Array.Clear(overlay);
                for (var i = 0; i < bgra.Length; i += 4)
                {
                    var b = bgra[i];
                    var g = bgra[i + 1];
                    var r = bgra[i + 2];
                    if (_clipHighlightOn && (r >= 254 || g >= 254 || b >= 254))
                    {
                        overlay[i + 2] = 0xD1;    // red, premultiplied BGRA
                        overlay[i + 1] = 0x58;
                        overlay[i] = 0x4A;
                        overlay[i + 3] = 0xFF;
                    }
                    else if (_clipShadowOn && r <= 1 && g <= 1 && b <= 1)
                    {
                        overlay[i + 2] = 0x4F;    // blue
                        overlay[i + 1] = 0x7F;
                        overlay[i] = 0xC4;
                        overlay[i + 3] = 0xFF;
                    }
                }
                using (var stream = _clipOverlayBitmap.PixelBuffer.AsStream())
                {
                    stream.Write(overlay, 0, overlay.Length);
                }
                _clipOverlayBitmap.Invalidate();
                ClipOverlayImage.Visibility = Visibility.Visible;
            });
        }

        // --- Menu (#2586) — thin shims over the same actions the shortcut
        //     table drives; zoom items are inert in Browse like the keys. ---

        private void OnMenuExit(object sender, RoutedEventArgs e) => Close();
        private void OnMenuUndo(object sender, RoutedEventArgs e) => ViewModel.Undo();
        private void OnMenuRedo(object sender, RoutedEventArgs e) => ViewModel.Redo();
        private void OnMenuModeBrowse(object sender, RoutedEventArgs e) => SetMode(ShellMode.Browse);

        private void OnMenuModePreview(object sender, RoutedEventArgs e)
        {
            if (ViewModel.SelectedPhoto != null)
                SetMode(ShellMode.Preview);
        }

        private void OnMenuZoomFit(object sender, RoutedEventArgs e)
        {
            if (_mode != ShellMode.Browse)
                ResetZoom();
        }

        private void OnMenuZoomOneToOne(object sender, RoutedEventArgs e)
        {
            if (_mode != ShellMode.Browse)
                SetZoom(OneToOneZoomFactor());
        }

        private void OnMenuZoomIn(object sender, RoutedEventArgs e)
        {
            if (_mode != ShellMode.Browse)
                SetZoom(ViewerScroll.ZoomFactor * 1.5f);
        }

        private void OnMenuZoomOut(object sender, RoutedEventArgs e)
        {
            if (_mode != ShellMode.Browse)
                SetZoom(ViewerScroll.ZoomFactor / 1.5f);
        }

        private void OnMenuRating(object sender, RoutedEventArgs e)
        {
            if (sender is FrameworkElement { Tag: string tag } && int.TryParse(tag, out var stars))
            {
                ViewModel.SetRating(stars);
                UpdateStarRow();
            }
        }

        private void OnMenuFlagPick(object sender, RoutedEventArgs e) => ViewModel.SetFlag("pick");
        private void OnMenuFlagReject(object sender, RoutedEventArgs e) => ViewModel.SetFlag("reject");
        private void OnMenuFlagUnflag(object sender, RoutedEventArgs e) => ViewModel.SetFlag("none");
    }
}

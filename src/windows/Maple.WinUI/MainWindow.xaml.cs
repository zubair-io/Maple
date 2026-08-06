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
            }

            ViewModel.Renderer.FrameReady += OnFrameReady;
            ViewModel.Renderer.GpuFrameReady += OnGpuFrameReady;
            ViewModel.Renderer.HistogramReady += bins =>
                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    _lastHistogramBins = bins;
                    HistogramView.Draw(HistogramCanvas, bins);
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
            };
            ViewModel.Photos.CollectionChanged += (_, _) =>
            {
                LibraryCountText.Text = $"{ViewModel.Photos.Count} photos";
                EmptyStateText.Visibility =
                    ViewModel.Photos.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            };

            SidebarColDef.Width = new GridLength(_settings.LeftPanelHidden ? 0 : _settings.LeftPanelWidth);
            PhotoGrid.PreviewKeyDown += (_, e) =>
            {
                if (e.Key == VirtualKey.Enter)
                {
                    EnterPreview();
                    e.Handled = true;
                }
            };
            BuildStarRow();
            BuildEditRail();
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

            BrowseToolbar.Visibility = browse ? Visibility.Visible : Visibility.Collapsed;
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

        private void EnterPreview()
        {
            if (ViewModel.SelectedPhoto == null && ViewModel.Photos.Count > 0)
                ViewModel.SelectedPhoto = ViewModel.Photos[0];
            if (ViewModel.SelectedPhoto != null)
                SetMode(ShellMode.Preview);
        }

        private void OnViewerBack(object sender, RoutedEventArgs e) => SetMode(ShellMode.Browse);

        private async void OnEnterEdit(object sender, RoutedEventArgs e)
        {
            if (ViewModel.SelectedPhoto is { IsCloud: true })
            {
                await ShowMessageAsync("Maple Cloud",
                    "Cloud photos can be browsed and culled; editing needs the original "
                    + "on this machine. Download-to-edit is tracked on #2588.");
                return;
            }
            SetMode(ShellMode.Edit);
            ViewModel.EnsureDecoded();
        }

        private void OnExitEdit(object sender, RoutedEventArgs e) => SetMode(ShellMode.Preview);

        // --- Rendering ---

        private void OnGpuFrameReady(int width, int height, double millis)
        {
            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                _gpuFrameDims = (width, height);
                UpdatePanelFit();
                ViewportSwapChainPanel.Visibility = Visibility.Visible;
                ViewportImage.Visibility = Visibility.Collapsed;
                RenderStatsText.Text = $"{width}×{height} · GPU {millis:0} ms";
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
        }

        private void OnCanvasHostSizeChanged(object sender, SizeChangedEventArgs e)
        {
            UpdatePanelFit();
            SizeZoomHost();
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

        private void OnPhotoItemClick(object sender, ItemClickEventArgs e)
        {
            if (e.ClickedItem is PhotoItem photo)
                ViewModel.SelectedPhoto = photo;
        }

        private void OnGridDoubleTapped(object sender, DoubleTappedRoutedEventArgs e) => EnterPreview();

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
            if (args.InvokedItem is FolderNode { IsPlaceholder: false } node)
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
                case VirtualKey.E when !ctrl && _mode == ShellMode.Preview
                        && ViewModel.SelectedPhoto is not { IsCloud: true }:
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
    }
}

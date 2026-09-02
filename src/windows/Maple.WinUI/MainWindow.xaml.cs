using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
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

        private readonly AppSettings _settings = AppSettings.Load();
        private ShellMode _mode = ShellMode.Browse;
        private uint[]? _lastHistogramBins;
        private IntPtr _panelNative;

        /// <summary>WinUI 3 DXInterop ISwapChainPanelNative IID — the interface
        /// wgpu's DX12 surface QIs SetSwapChain through.</summary>
        private static Guid _swapChainPanelNativeIid =
            new("63AAD0B8-7C24-40FF-85A8-640D944CC325");

        public MainWindow()
        {
            ViewModel = new EditSessionViewModel();
            this.InitializeComponent();

            // #3079: fold the menu row into the frame's title-bar strip —
            // system caption buttons overlay its right edge, the region
            // right of the menus drags the window.
            Maple.UI.MuiWindowChrome.Extend(this, TitleBarDragRegion);

            // #2589: Maple Cloud in File Explorer. Constructed with an
            // accessor (reconnects replace the client instance); started
            // eagerly when enabled — the sync root itself needs no session,
            // and its callbacks answer empty until one is restored.
            _cloudFiles = new Services.CloudFiles.CloudFilesSyncRoot(() => ViewModel.ActiveCloudClient);
            if (Services.AppSettings.Load().CloudFilesEnabled)
            {
                var startError = _cloudFiles.Start();
                if (startError != null)
                {
                    // Keep the persisted flag aligned with reality — a
                    // failed startup must not leave the Settings checkbox
                    // claiming the sync root is running.
                    Services.AppSettings.Update(s => s.CloudFilesEnabled = false);
                    Services.DiagLog.Write($"[cloudfiles] startup: {startError} — setting disabled");
                }
            }

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
            // A cloud directory holding only subfolders is not "empty" — its
            // folder tiles ARE the content — so the empty-state text keys off
            // both collections (#3082).
            void UpdateEmptyState() => EmptyStateText.Visibility =
                ViewModel.Photos.Count == 0 && ViewModel.BrowseFolders.Count == 0
                    ? Visibility.Visible
                    : Visibility.Collapsed;
            ViewModel.Photos.CollectionChanged += (_, _) =>
            {
                UpdateLibraryCountText();
                UpdateEmptyState();
            };
            ViewModel.BrowseFolders.CollectionChanged += (_, _) => UpdateEmptyState();

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
            // The grid has two presentations (docs/spec/13-windows-shell.md):
            // date-grouped (Timeline selected → PhotoGroups, day headers) and
            // flat Finder-style (folder browse → Photos, no headers). The
            // CollectionViewSource is retargeted whenever the VM flips.
            var gridSource = (Microsoft.UI.Xaml.Data.CollectionViewSource)
                ((FrameworkElement)Content).Resources["GroupedPhotosSource"];
            void RetargetGridSource()
            {
                gridSource.Source = null;   // detach before flipping grouping
                gridSource.IsSourceGrouped = ViewModel.IsDateGrouped;
                gridSource.Source = ViewModel.IsDateGrouped
                    ? ViewModel.PhotoGroups
                    : (object)ViewModel.Photos;
            }
            RetargetGridSource();
            ViewModel.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(ViewModel.IsDateGrouped))
                    RetargetGridSource();
            };
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
    }
}

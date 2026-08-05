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
            ViewModel.Renderer.RenderFailed += message =>
                App.MainDispatcherQueue?.TryEnqueue(() => RenderStatsText.Text = $"render error: {message}");
            ViewModel.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(ViewModel.SelectedPhoto))
                    OnSelectedPhotoChanged();
            };
            ViewModel.Photos.CollectionChanged += (_, _) =>
                LibraryCountText.Text = $"{ViewModel.Photos.Count} photos";

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
        private void OnEnterEdit(object sender, RoutedEventArgs e) => SetMode(ShellMode.Edit);
        private void OnExitEdit(object sender, RoutedEventArgs e) => SetMode(ShellMode.Preview);

        // --- Rendering ---

        private void OnFrameReady(byte[] bgra, int width, int height, uint[] bins, double millis)
        {
            var copy = new byte[bgra.Length];
            Buffer.BlockCopy(bgra, 0, copy, 0, bgra.Length);
            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
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
        }

        // --- Library scopes / filters ---

        private void OnSelectLibraryScope(object sender, SelectionChangedEventArgs e)
        {
            if (LibraryList.SelectedItem is not ListViewItem item)
                return;
            var scope = item.Tag as string;
            ViewModel.DateFilterDay = null;
            ViewModel.FlagFilter = scope is "pick" or "reject" ? scope : "all";
            ViewModel.MinRatingFilter = scope == "rated4" ? 4 : 0;
        }

        private void OnSelectFolder(object sender, SelectionChangedEventArgs e)
        {
            if (FoldersList.SelectedItem is string folder)
            {
                ViewModel.DateFilterDay = null;
                ViewModel.LoadDirectory(folder);
                SetMode(ShellMode.Browse);
            }
        }

        private void OnSelectTimelineGroup(object sender, SelectionChangedEventArgs e)
        {
            if (sender is ListView list && list.SelectedItem is TimelineGroup group)
            {
                ViewModel.DateFilterDay = group.SortKey;
                SetMode(ShellMode.Browse);
            }
        }

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
                case VirtualKey.E when !ctrl && _mode == ShellMode.Preview: SetMode(ShellMode.Edit); break;
                case VirtualKey.Escape when _mode == ShellMode.Edit: SetMode(ShellMode.Preview); break;
                case VirtualKey.Escape when _mode == ShellMode.Preview: SetMode(ShellMode.Browse); break;
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

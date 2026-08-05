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
    public sealed partial class MainWindow : Window
    {
        public EditSessionViewModel ViewModel { get; }

        private WriteableBitmap? _viewportBitmap;
        private readonly AppSettings _settings = AppSettings.Load();
        private bool _inDevelopMode;

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
            InspectorColDef.Width = new GridLength(_settings.DetailPanelHidden ? 0 : _settings.DetailPanelWidth);
            SetActiveModeButton(browse: true);
            SetActiveTab(TabDevelopBtn);
            BuildStarRow();
            this.Closed += (_, _) => ViewModel.Dispose();
        }

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
                RenderStatsText.Text = $"{width}×{height} · chain {millis:0} ms";
                ViewModel.LastRenderMillis = millis;
                HistogramView.Draw(HistogramCanvas, bins);
            });
        }

        // --- Mode / panel chrome ---

        private void OnSwitchToBrowse(object sender, RoutedEventArgs e) => SwitchMode(develop: false);

        private void OnSwitchToDevelop(object sender, RoutedEventArgs e) => SwitchMode(develop: true);

        private void SwitchMode(bool develop)
        {
            _inDevelopMode = develop;
            BrowseGridContainer.Visibility = develop ? Visibility.Collapsed : Visibility.Visible;
            DevelopContainer.Visibility = develop ? Visibility.Visible : Visibility.Collapsed;
            SetActiveModeButton(browse: !develop);
            if (develop && ViewModel.SelectedPhoto == null && ViewModel.Photos.Count > 0)
                ViewModel.SelectedPhoto = ViewModel.Photos[0];
        }

        private void SetActiveModeButton(bool browse)
        {
            var accent = (Style)Application.Current.Resources["AccentButtonStyle"];
            BrowseModeBtn.Style = browse ? accent : (Style)Application.Current.Resources["DefaultButtonStyle"];
            DevelopModeBtn.Style = browse ? (Style)Application.Current.Resources["DefaultButtonStyle"] : accent;
        }

        private void OnToggleSidebar(object sender, RoutedEventArgs e)
        {
            var hidden = SidebarColDef.Width.Value > 0;
            SidebarColDef.Width = new GridLength(hidden ? 0 : Math.Max(_settings.LeftPanelWidth, 200));
            _settings.LeftPanelHidden = hidden;
            _settings.Save();
        }

        private void OnToggleInspector(object sender, RoutedEventArgs e)
        {
            var hidden = InspectorColDef.Width.Value > 0;
            InspectorColDef.Width = new GridLength(hidden ? 0 : Math.Max(_settings.DetailPanelWidth, 280));
            _settings.DetailPanelHidden = hidden;
            _settings.Save();
        }

        private void OnSelectInspectorTab(object sender, RoutedEventArgs e) =>
            SetActiveTab((Button)sender);

        private void SetActiveTab(Button active)
        {
            var accent = (Style)Application.Current.Resources["AccentButtonStyle"];
            var normal = (Style)Application.Current.Resources["DefaultButtonStyle"];
            TabDevelopBtn.Style = active == TabDevelopBtn ? accent : normal;
            TabInfoBtn.Style = active == TabInfoBtn ? accent : normal;
            AdjustmentsPanel.Visibility = active == TabDevelopBtn ? Visibility.Visible : Visibility.Collapsed;
            InfoPanel.Visibility = active == TabInfoBtn ? Visibility.Visible : Visibility.Collapsed;
            if (active == TabInfoBtn)
                RefreshInfoPanel();
        }

        // --- Selection ---

        private void OnPhotoItemClick(object sender, ItemClickEventArgs e)
        {
            if (e.ClickedItem is PhotoItem photo)
            {
                ViewModel.SelectedPhoto = photo;
                SwitchMode(develop: true);
            }
        }

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
            if (InfoPanel.Visibility == Visibility.Visible)
                RefreshInfoPanel();
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
                SwitchMode(develop: false);
            }
        }

        private void OnSelectTimelineGroup(object sender, SelectionChangedEventArgs e)
        {
            if (sender is ListView list && list.SelectedItem is TimelineGroup group)
            {
                ViewModel.DateFilterDay = group.SortKey;
                SwitchMode(develop: false);
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

        // --- Adjustments chrome ---

        private void OnSliderRowDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            if (sender is FrameworkElement { DataContext: AdjustmentSliderViewModel slider })
                slider.Reset();
        }

        private void OnApplyAuto(object sender, RoutedEventArgs e) => ViewModel.ApplyAuto();

        private void OnRevert(object sender, RoutedEventArgs e) => ViewModel.RevertToOriginal();

        // --- Culling ---

        private void OnFlagPick(object sender, RoutedEventArgs e) => ViewModel.SetFlag("pick");
        private void OnFlagReject(object sender, RoutedEventArgs e) => ViewModel.SetFlag("reject");
        private void OnFlagNone(object sender, RoutedEventArgs e) => ViewModel.SetFlag("none");

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
                case VirtualKey.Up: ViewModel.SelectNeighbor(-10); break;
                case VirtualKey.Down: ViewModel.SelectNeighbor(10); break;
                case VirtualKey.Escape when _inDevelopMode: SwitchMode(develop: false); break;
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

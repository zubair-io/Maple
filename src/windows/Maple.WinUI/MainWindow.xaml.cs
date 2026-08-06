using System;
using System.IO;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public partial class MainWindow : Window
    {
        public EditSessionViewModel ViewModel { get; }

        public MainWindow()
        {
            ViewModel = new EditSessionViewModel();
            this.InitializeComponent();

            if (this.Content is FrameworkElement rootElement)
            {
                rootElement.DataContext = ViewModel;
            }
        }

        private void OnAdjustmentChanged(object sender, RangeBaseValueChangedEventArgs e)
        {
            // Real-time 60Hz adjustment tick
        }

        private void OnSwitchToBrowse(object sender, RoutedEventArgs e)
        {
            if (ViewModel == null || BrowseGridContainer == null || DevelopContainer == null) return;

            ViewModel.SwitchToBrowseMode();
            BrowseGridContainer.Visibility = Visibility.Visible;
            DevelopContainer.Visibility = Visibility.Collapsed;

            if (BrowseModeBtn != null) BrowseModeBtn.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
            if (DevelopModeBtn != null) DevelopModeBtn.Style = null;
        }

        private void OnSwitchToDevelop(object sender, RoutedEventArgs e)
        {
            if (ViewModel == null || BrowseGridContainer == null || DevelopContainer == null) return;

            ViewModel.SwitchToDevelopMode();
            BrowseGridContainer.Visibility = Visibility.Collapsed;
            DevelopContainer.Visibility = Visibility.Visible;

            if (BrowseModeBtn != null) BrowseModeBtn.Style = null;
            if (DevelopModeBtn != null) DevelopModeBtn.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        }

        private void OnPhotoItemClick(object sender, ItemClickEventArgs e)
        {
            if (ViewModel == null) return;
            if (e.ClickedItem is PhotoItem photo)
            {
                ViewModel.SelectedPhoto = photo;
                OnSwitchToDevelop(sender, new RoutedEventArgs());
            }
        }

        private void OnToggleSidebar(object sender, RoutedEventArgs e)
        {
            if (SidebarColDef == null) return;
            if (SidebarColDef.Width.Value > 0)
            {
                SidebarColDef.Width = new GridLength(0);
            }
            else
            {
                SidebarColDef.Width = new GridLength(260);
            }
        }

        private void OnToggleInspector(object sender, RoutedEventArgs e)
        {
            if (InspectorColDef == null) return;
            if (InspectorColDef.Width.Value > 0)
            {
                InspectorColDef.Width = new GridLength(0);
            }
            else
            {
                InspectorColDef.Width = new GridLength(320);
            }
        }

        private void OnSelectInspectorTab(object sender, RoutedEventArgs e)
        {
            if (sender is Button btn)
            {
                if (TabAdjustmentsBtn != null) TabAdjustmentsBtn.Style = null;
                if (TabInfoBtn != null) TabInfoBtn.Style = null;
                if (TabPresetsBtn != null) TabPresetsBtn.Style = null;

                if (AdjustmentsPanel != null) AdjustmentsPanel.Visibility = Visibility.Collapsed;
                if (InfoPanel != null) InfoPanel.Visibility = Visibility.Collapsed;
                if (PresetsPanel != null) PresetsPanel.Visibility = Visibility.Collapsed;

                btn.Style = (Style)Application.Current.Resources["AccentButtonStyle"];

                if (btn == TabAdjustmentsBtn && AdjustmentsPanel != null)
                {
                    AdjustmentsPanel.Visibility = Visibility.Visible;
                }
                else if (btn == TabInfoBtn && InfoPanel != null)
                {
                    InfoPanel.Visibility = Visibility.Visible;
                }
                else if (btn == TabPresetsBtn && PresetsPanel != null)
                {
                    PresetsPanel.Visibility = Visibility.Visible;
                }
            }
        }

        private async void OnOpenDirectory(object sender, RoutedEventArgs e)
        {
            var picker = new Windows.Storage.Pickers.FolderPicker();
            picker.SuggestedStartLocation = Windows.Storage.Pickers.PickerLocationId.PicturesLibrary;
            picker.FileTypeFilter.Add("*");

            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
            WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);

            var folder = await picker.PickSingleFolderAsync();
            if (folder != null && ViewModel != null)
            {
                ViewModel.LoadDirectory(folder.Path);
                OnSwitchToBrowse(sender, new RoutedEventArgs());

                // Add folder to TreeView under Local Pictures node
                if (LocalPicturesNode != null)
                {
                    bool exists = false;
                    foreach (var child in LocalPicturesNode.Children)
                    {
                        if (child.Content is string path && string.Equals(path, folder.Path, StringComparison.OrdinalIgnoreCase))
                        {
                            exists = true;
                            break;
                        }
                    }

                    if (!exists)
                    {
                        var folderNode = new TreeViewNode
                        {
                            Content = folder.Path
                        };
                        LocalPicturesNode.Children.Add(folderNode);
                    }
                    LocalPicturesNode.IsExpanded = true;
                }
            }
        }

        private void OnSelectSidebarItem(object sender, SelectionChangedEventArgs e)
        {
            if (ViewModel == null) return;
            if (sender is ListView lv && lv.SelectedItem is ListViewItem item)
            {
                string myPictures = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
                if (Directory.Exists(myPictures))
                {
                    ViewModel.LoadDirectory(myPictures);
                }
            }
        }

        private void OnSelectTreeViewNode(TreeView sender, TreeViewItemInvokedEventArgs args)
        {
            if (ViewModel == null) return;
            if (args.InvokedItem is TreeViewNode node && node.Content is string text)
            {
                if (Directory.Exists(text))
                {
                    ViewModel.LoadDirectory(text);
                    OnSwitchToBrowse(sender, new RoutedEventArgs());
                }
                else if (text == "Local Pictures")
                {
                    string myPictures = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
                    if (Directory.Exists(myPictures))
                    {
                        ViewModel.LoadDirectory(myPictures);
                        OnSwitchToBrowse(sender, new RoutedEventArgs());
                    }
                }
            }
        }

        private async void OnOpenPanoStitch(object sender, RoutedEventArgs e)
        {
            var panel = new StackPanel { Spacing = 12, Width = 360 };
            panel.Children.Add(new TextBlock
            {
                Text = "Select projection mode and feature matching alignment options for the selected RAW frames.",
                TextWrapping = TextWrapping.Wrap,
                Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["TextFillColorSecondaryBrush"]
            });

            var modeCombo = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch, SelectedIndex = 0 };
            modeCombo.Items.Add("Spherical (Best for wide landscapes)");
            modeCombo.Items.Add("Cylindrical (Best for tall architecture)");
            modeCombo.Items.Add("Perspective (Flat rectilinear projection)");
            panel.Children.Add(modeCombo);

            var cropCheck = new CheckBox { Content = "Auto-Crop Black Borders", IsChecked = true };
            panel.Children.Add(cropCheck);

            var dialog = new ContentDialog
            {
                Title = "Panorama Stitcher (maple-pano)",
                Content = panel,
                PrimaryButtonText = "Stitch Panorama",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary
            };

            if (this.Content is FrameworkElement rootElement)
            {
                dialog.XamlRoot = rootElement.XamlRoot;
            }

            await dialog.ShowAsync();
        }

        private async void OnExportPhotos(object sender, RoutedEventArgs e)
        {
            var panel = new StackPanel { Spacing = 12, Width = 360 };

            var formatCombo = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch, SelectedIndex = 0 };
            formatCombo.Items.Add("JPEG (sRGB 8-bit)");
            formatCombo.Items.Add("TIFF (Display P3 16-bit)");
            formatCombo.Items.Add("PNG (sRGB 8-bit)");
            formatCombo.Items.Add("DNG (Linear DNG RAW)");
            panel.Children.Add(new TextBlock { Text = "Export Format", FontWeight = Microsoft.UI.Text.FontWeights.SemiBold });
            panel.Children.Add(formatCombo);

            var qualitySlider = new Slider { Minimum = 50, Maximum = 100, Value = 92, StepFrequency = 1 };
            panel.Children.Add(new TextBlock { Text = "Quality / Compression (92%)" });
            panel.Children.Add(qualitySlider);

            var sidecarCheck = new CheckBox { Content = "Preserve Original XMP Sidecar Metadata", IsChecked = true };
            panel.Children.Add(sidecarCheck);

            var dialog = new ContentDialog
            {
                Title = "Batch Export Photos",
                Content = panel,
                PrimaryButtonText = "Export",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary
            };

            if (this.Content is FrameworkElement rootElement)
            {
                dialog.XamlRoot = rootElement.XamlRoot;
            }

            await dialog.ShowAsync();
        }
    }
}

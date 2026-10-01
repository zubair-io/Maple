using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        // --- Preview Info: rating, flags and metadata ---

        /// <summary>MuiButton stars, not MuiRatingFlags: the molecule's
        /// same-star click DECREMENTS and it bundles a cycling flag icon,
        /// while this inspector's contract is click-current-to-clear plus the
        /// separate Pick/Reject buttons — behavior preserved as-is (MN4).</summary>
        private void BuildStarRow()
        {
            for (var i = 0; i < 5; i++)
            {
                var stars = i + 1;
                var button = new MuiButton
                {
                    IconName = "star",
                    Variant = MuiButtonVariant.Ghost,
                    ButtonSize = MuiButtonSize.Sm,
                    IconSize = MuiIconSize.Md24,
                    IconColor = (SolidColorBrush)Application.Current.Resources["MapleBorderHi"],
                };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, $"Set rating {stars}");
                button.Click += (_, _) =>
                {
                    var current = ViewModel.SelectedPhoto?.Rating ?? 0;
                    ViewModel.SetRating(current == stars ? 0 : stars);
                    UpdateStarRow();
                };
                _starButtons[i] = button;
                StarRow.Children.Add(button);
            }
        }

        private void UpdateStarRow()
        {
            if (_starButtons[0] == null)
                return;  // selection can fire before the chrome is built
            var rating = ViewModel.SelectedPhoto?.Rating ?? 0;
            var star = (SolidColorBrush)Application.Current.Resources["MaplePrimary"];
            var muted = (SolidColorBrush)Application.Current.Resources["MapleBorderHi"];
            for (var i = 0; i < 5; i++)
            {
                _starButtons[i].IconName = i < rating ? "star-filled" : "star";
                _starButtons[i].IconColor = i < rating ? star : muted;
            }
        }

        // --- Docked Preview inspector ---

        private bool _infoPaneOpen;

        private void OnToggleInfoPane(object sender, RoutedEventArgs e)
        {
            _infoPaneOpen = !_infoPaneOpen;
            UpdateInfoPane();
        }

        private void UpdateInfoPane()
        {
            var visible = _mode == ShellMode.Preview && _infoPaneOpen;
            InfoPane.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
            InfoColDef.Width = new GridLength(visible ? 320 : 0);
            UpdateResponsiveShell();
            if (visible) RefreshPhotoInfo();
            else CancelInspectorHydration();
        }

        private void RefreshPhotoInfo()
        {
            var photo = ViewModel.SelectedPhoto;
            HydrateInspector();
            UpdateStarRow();
            UnflaggedBtn.Selected = photo?.FlagStatus is not ("pick" or "reject");
            PickBtn.Selected = photo?.FlagStatus == "pick";
            RejectBtn.Selected = photo?.FlagStatus == "reject";
            ExifRows.Children.Clear();
            FileRows.Children.Clear();
            if (photo == null)
                return;

            void AddRow(StackPanel host, string label, string value)
            {
                host.Children.Add(new Maple.UI.MuiLabelValueGrid
                {
                    LabelWidth = 76,
                    Rows = new[] { new Maple.UI.MuiLabelValueRow(label, value) },
                });
            }

            AddRow(ExifRows, "Camera", photo.CameraModel);
            AddRow(ExifRows, "Dimensions", photo.Dimensions);
            AddRow(ExifRows, "Lens", photo.LensInfo);
            AddRow(ExifRows, "ISO", photo.IsoDisplay);
            AddRow(ExifRows, "Aperture", photo.Aperture);
            AddRow(ExifRows, "Shutter", photo.ShutterSpeed);
            AddRow(ExifRows, "Captured", photo.DateTaken);
            AddRow(FileRows, "Name", photo.FileName);
            AddRow(FileRows, "Format", photo.Format);
            AddRow(FileRows, "Size", Services.StorageReport.FormatBytes(photo.FileSizeBytes));
            AddRow(FileRows, "Modified", photo.FileModifiedUtc == default ? "—"
                : photo.FileModifiedUtc.ToLocalTime().ToString("yyyy-MM-dd HH:mm"));
            AddRow(FileRows, "Pixels", photo.Dimensions);
            AddRow(FileRows, photo.IsCloud ? "Server path" : "Path", photo.FilePath);
            AddRow(FileRows, "Color label", photo.ColorLabel ?? "None");
            var support = new StackPanel();
            AddCameraSupport(support, photo);
            if (support.Children.Count > 0)
                FileRows.Children.Add(new Expander { Header = "Camera and lens support", Content = support,
                    HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch });
        }
    }
}

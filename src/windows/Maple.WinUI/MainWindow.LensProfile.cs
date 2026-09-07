using System;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Data;
using Maple.UI.Atoms;
using Maple.WinUI.Services;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private readonly MuiButton _importLensProfile = new() { Label = "Import lens profile…", ButtonSize = MuiButtonSize.Sm };
        private readonly MuiButton _clearLensProfile = new() { Label = "Use embedded only", ButtonSize = MuiButtonSize.Sm };
        private readonly TextBlock _lensProfileMessage = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12 };

        private void BuildLensProfilePanel()
        {
            PanelLensProfileHost.Children.Add(new TextBlock { Text = "Lens profile", FontSize = 12 });
            AutomationProperties.SetName(_importLensProfile, "Import lens profile");
            AutomationProperties.SetName(_clearLensProfile, "Use embedded lens corrections only");
            _importLensProfile.Click += async (_, _) => await ImportLensProfileAsync();
            _clearLensProfile.Click += (_, _) => ViewModel.SelectLensProfile("");
            PanelLensProfileHost.Children.Add(_importLensProfile);
            PanelLensProfileHost.Children.Add(_clearLensProfile);
            var selected = new TextBlock { TextWrapping = TextWrapping.Wrap, FontSize = 12 };
            selected.SetBinding(TextBlock.TextProperty, new Binding { Source = ViewModel, Path = new PropertyPath("LensProfileInfo"), Mode = BindingMode.OneWay });
            PanelLensProfileHost.Children.Add(selected);
            PanelLensProfileHost.Children.Add(_lensProfileMessage);
            BuildLensControls();
        }

        private async Task ImportLensProfileAsync()
        {
            var photo = ViewModel.SelectedPhoto;
            if (photo == null) return;
            var picker = new Windows.Storage.Pickers.FileOpenPicker();
            picker.FileTypeFilter.Add(".lcp");
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var file = await picker.PickSingleFileAsync();
            if (file == null || !ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
            _importLensProfile.IsEnabled = false;
            _lensProfileMessage.Text = "Reading lens profile…";
            try
            {
                var profile = await Task.Run(() => LensProfileStore.Import(file.Path, photo.EditPath));
                if (!ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
                _lensProfileMessage.Text = profile.Name + "\n" + profile.Description;
                if (profile.Embedded) return;
                var dialog = new ContentDialog
                {
                    XamlRoot = Content.XamlRoot, Title = profile.Name,
                    Content = new TextBlock { Text = profile.Description, TextWrapping = TextWrapping.Wrap },
                    PrimaryButtonText = profile.Approximate ? "Accept approximation and use profile" : "Use profile",
                    CloseButtonText = "Cancel",
                };
                var accepted = await dialog.ShowAsync();
                if (accepted == ContentDialogResult.Primary && ReferenceEquals(photo, ViewModel.SelectedPhoto))
                    ViewModel.SelectLensProfile(profile.Approximate ? profile.Reference.Replace("lcp1:", "lcp1-ack:") : profile.Reference);
            }
            catch (Exception error)
            {
                if (ReferenceEquals(photo, ViewModel.SelectedPhoto)) _lensProfileMessage.Text = error.Message;
            }
            finally { _importLensProfile.IsEnabled = true; }
        }
    }
}

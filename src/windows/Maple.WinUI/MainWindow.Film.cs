using System.Globalization;
using System.Linq;
using Maple.UI;
using Maple.WinUI.Generated;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private readonly MuiFilmPanel _filmPanel = new();
    private readonly TextBlock _filmStatus = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12 };
    private bool _filmSyncing;

    private void BuildFilmPanel()
    {
        _filmPanel.SelectedCategoryId = string.Empty;
        _filmPanel.Categories = new[] { new MuiChip("", "All") }.Concat(
            FilmCatalog.All.Select(look => look.Category).Distinct().Select(category => new MuiChip(category,
                CultureInfo.InvariantCulture.TextInfo.ToTitleCase(category.Replace('_', ' '))))).ToArray();
        _filmPanel.Looks = FilmCatalog.All.Select(look => new MuiFilmLook(look.Id, look.Category, look.Name)).ToArray();
        _filmPanel.LookSelected += (_, id) => { if (!_filmSyncing) ViewModel.SelectFilm(id); };
        _filmPanel.StrengthChanged += (_, value) => { if (!_filmSyncing) ViewModel.SetFilmStrength(value); };
        AutomationProperties.SetLiveSetting(_filmStatus, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        PanelFilmHost.Children.Add(_filmStatus);
        PanelFilmHost.Children.Add(_filmPanel);
        SyncFilmPanel();
    }

    private void SyncFilmPanel()
    {
        _filmSyncing = true;
        _filmPanel.SelectedLookId = ViewModel.Adjustments.FilmLook;
        _filmPanel.Strength = ViewModel.Adjustments.FilmStrength;
        _filmPanel.IsEnabled = ViewModel.SelectedPhoto != null;
        var look = FilmCatalog.All.FirstOrDefault(entry => entry.Id == ViewModel.Adjustments.FilmLook);
        _filmStatus.Text = string.IsNullOrEmpty(ViewModel.Adjustments.FilmLook) ? "No film look"
            : look?.Name ?? $"Unavailable look: {ViewModel.Adjustments.FilmLook}. Preserved in the sidecar; choose a look or None to replace it.";
        _filmSyncing = false;
    }

    private void OnFilmTools(object sender, RoutedEventArgs e) => ToggleGroupPanel("Film");
}

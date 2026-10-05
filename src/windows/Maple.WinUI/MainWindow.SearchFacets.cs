using System;
using System.Linq;
using Maple.WinUI.Services.Cloud;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private bool _updatingSearchFacets;

    private void UpdateSearchFacetControls()
    {
        if (!_browseDesignReady) return;
        _updatingSearchFacets = true;
        try
        {
            CloudSearchOptions.Visibility = ViewModel.IsServerSearch ? Visibility.Visible : Visibility.Collapsed;
            var facets = ViewModel.SearchFacets;
            ScopeSearchBox.SelectedIndex = (int)ViewModel.CloudSearchScope;
            Fill(PeopleSearchBox, facets?.People, ViewModel.CloudPeopleFilter, "All people");
            Fill(PlaceSearchBox, facets?.Places, ViewModel.CloudPlaceFilter, "All places");
            var owners = ViewModel.OwnerFilterOptions();
            OwnerSearchBox.Items.Clear();
            foreach (var option in owners)
                OwnerSearchBox.Items.Add(new ComboBoxItem { Content = option.Label, Tag = option.Id });
            OwnerSearchBox.SelectedItem = OwnerSearchBox.Items.Cast<ComboBoxItem>()
                .First(i => CloudOwnerOptions.SameId((string)i.Tag, ViewModel.CloudOwnerFilter));
            OwnerSearchBox.IsEnabled = owners.Count > 1;
            HiddenSearchBox.IsEnabled = facets?.SupportedFilters?.Contains("hidden", StringComparer.Ordinal) == true
                || ViewModel.CloudHiddenFilter != CloudHiddenFilter.None;
            HiddenSearchBox.SelectedIndex = (int)ViewModel.CloudHiddenFilter;
        }
        finally { _updatingSearchFacets = false; }

        static void Fill(ComboBox box, CloudSearchBucket[]? buckets, string selected, string all)
        {
            box.Items.Clear();
            box.Items.Add(new ComboBoxItem { Content = all, Tag = "" });
            foreach (var bucket in buckets ?? Array.Empty<CloudSearchBucket>())
                box.Items.Add(new ComboBoxItem { Content = $"{bucket.Value} ({bucket.Count})", Tag = bucket.Value });
            // Keep an active filter visible even if it now has zero results.
            if (selected.Length > 0 && !(buckets?.Any(b => b.Value == selected) ?? false))
                box.Items.Add(new ComboBoxItem { Content = selected, Tag = selected });
            box.SelectedItem = box.Items.Cast<ComboBoxItem>().First(i => (string)i.Tag == selected);
            box.IsEnabled = buckets != null || selected.Length > 0;
        }
    }

    private void OnSearchFacetSelected(object sender, SelectionChangedEventArgs e)
    {
        if (!_browseDesignReady || _updatingSearchFacets) return;
        if (ReferenceEquals(sender, ColorSearchBox) && ColorSearchBox.SelectedItem is ComboBoxItem color)
            ViewModel.ColorFilter = (string)color.Tag;
        else if (ViewModel.IsServerSearch)
        {
            if (ReferenceEquals(sender, ScopeSearchBox) && ScopeSearchBox.SelectedIndex >= 0)
                ViewModel.CloudSearchScope = (CloudSearchScope)ScopeSearchBox.SelectedIndex;
            if (ReferenceEquals(sender, PeopleSearchBox) && PeopleSearchBox.SelectedItem is ComboBoxItem person)
                ViewModel.CloudPeopleFilter = (string)person.Tag;
            else if (ReferenceEquals(sender, PlaceSearchBox) && PlaceSearchBox.SelectedItem is ComboBoxItem place)
                ViewModel.CloudPlaceFilter = (string)place.Tag;
            else if (ReferenceEquals(sender, OwnerSearchBox) && OwnerSearchBox.SelectedItem is ComboBoxItem assetOwner)
                ViewModel.CloudOwnerFilter = (string)assetOwner.Tag;
            else if (ReferenceEquals(sender, HiddenSearchBox) && HiddenSearchBox.SelectedIndex >= 0)
                ViewModel.CloudHiddenFilter = (CloudHiddenFilter)HiddenSearchBox.SelectedIndex;
        }
    }
}

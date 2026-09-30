using System;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    [ObservableProperty] private string _colorFilter = "all";
    [ObservableProperty] private string _cloudPeopleFilter = "";
    [ObservableProperty] private string _cloudPlaceFilter = "";
    [ObservableProperty] private CloudHiddenFilter _cloudHiddenFilter;
    [ObservableProperty] private CloudSearchFacets? _searchFacets;
    [ObservableProperty] private string _searchFacetStatus = "";

    partial void OnColorFilterChanged(string value) => ApplyFilters();
    partial void OnCloudPeopleFilterChanged(string value) => ApplyFilters();
    partial void OnCloudPlaceFilterChanged(string value) => ApplyFilters();
    partial void OnCloudHiddenFilterChanged(CloudHiddenFilter value) => ApplyFilters();

    private async Task RefreshSearchFacetsAsync(CancellationTokenSource owner, CloudSearchQuery query)
    {
        try
        {
            var facets = await _cloud!.GetSearchFacetsAsync(query, owner.Token);
            if (_libraryCts != owner || owner.IsCancellationRequested || !_isCloudTimeline) return;
            SearchFacetStatus = facets == null ? "This server does not provide search facets." : "";
            SearchFacets = facets;
        }
        catch (OperationCanceledException) when (owner.IsCancellationRequested) { }
        catch (Exception)
        {
            if (_libraryCts != owner || owner.IsCancellationRequested || !_isCloudTimeline) return;
            SearchFacetStatus = "Could not refresh search facets. Retry to try again.";
            CanRetryCloudSearch = true;
        }
    }
}

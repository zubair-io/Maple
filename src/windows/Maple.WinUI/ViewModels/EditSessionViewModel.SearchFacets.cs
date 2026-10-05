using System;
using System.Collections.Generic;
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
    [ObservableProperty] private CloudSearchScope _cloudSearchScope;
    [ObservableProperty] private CloudSearchFacets? _searchFacets;
    [ObservableProperty] private string _searchFacetStatus = "";
    // Asset-owner filter (#3817): a user id, or "" for all owners.
    [ObservableProperty] private string _cloudOwnerFilter = "";
    [ObservableProperty] private CloudOwnerFacet[]? _ownerFacets;
    private readonly Dictionary<string, string> _ownerLabels = new(StringComparer.OrdinalIgnoreCase);

    partial void OnColorFilterChanged(string value) => ApplyFilters();
    partial void OnCloudPeopleFilterChanged(string value) => ApplyFilters();
    partial void OnCloudPlaceFilterChanged(string value) => ApplyFilters();
    partial void OnCloudHiddenFilterChanged(CloudHiddenFilter value) => ApplyFilters();
    partial void OnCloudSearchScopeChanged(CloudSearchScope value) => ApplyFilters();
    partial void OnCloudOwnerFilterChanged(string value) => ApplyFilters();

    public IReadOnlyList<CloudOwnerOption> OwnerFilterOptions() =>
        CloudOwnerOptions.Build(OwnerFacets, _cloud?.CurrentUserId, CloudOwnerFilter, _ownerLabels);

    private async Task RefreshSearchFacetsAsync(CancellationTokenSource owner, CloudSearchQuery query)
    {
        try
        {
            // Owner choices reflect every other filter but not the owner
            // itself, so selecting one owner never hides the rest.
            var client = _cloud!;
            var facetsTask = client.GetSearchFacetsAsync(query, owner.Token);
            var ownersTask = query.OwnerId == null ? facetsTask
                : client.GetSearchFacetsAsync(query with { OwnerId = null }, owner.Token);
            await Task.WhenAll(facetsTask, ownersTask);
            var facets = facetsTask.Result;
            if (_libraryCts != owner || owner.IsCancellationRequested || !_isCloudTimeline) return;
            var owners = ownersTask.Result?.Owners;
            foreach (var bucket in owners ?? Array.Empty<CloudOwnerFacet>())
                _ownerLabels[bucket.Id] = CloudOwnerOptions.Label(bucket.Id, bucket.Email);
            SearchFacetStatus = facets == null ? "This server does not provide search facets." : "";
            // Before SearchFacets: its change notification refreshes the controls.
            OwnerFacets = owners;
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

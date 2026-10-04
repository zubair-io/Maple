using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        [ObservableProperty] private bool _hasMoreTimeline;
        [ObservableProperty] private bool _canRetryCloudSearch;
        private string? _timelineCursor;
        private int _timelinePage;
        private CloudSearchQuery? _timelineQuery;
        public bool IsServerSearch => _isCloudTimeline;

        public async Task LoadCloudTimelineAsync(bool preserveDateFilter = false)
        {
            var dateStart = DateFilterStart;
            var dateEnd = DateFilterEndExclusive;
            _libraryCts?.Cancel();
            _libraryCts = new CancellationTokenSource();
            _libraryWatcher?.Stop();
            _timelineQuery = null;
            BeginBrowse(timeline: true);
            if (preserveDateFilter)
            {
                DateFilterStart = dateStart;
                DateFilterEndExclusive = dateEnd;
            }
            CurrentFolderPath = string.Empty;
            ActiveSectionName = "Timeline";
            _timelineCursor = null;
            _timelinePage = 0;
            _timelineQuery = CurrentTimelineQuery();
            if (_cloud == null || !CloudConnected)
            {
                FinishBrowse(_libraryCts, "Connect to Maple Cloud to view your timeline.");
                return;
            }
            await LoadTimelinePageAsync(_libraryCts);
        }

        public async Task LoadMoreTimelineAsync()
        {
            if (!_isCloudTimeline || IsLibraryLoading || !HasMoreTimeline || _libraryCts == null) return;
            IsLibraryLoading = true;
            LibraryLoadStatus = "Loading…";
            await LoadTimelinePageAsync(_libraryCts);
        }

        public async Task RetryCloudSearchAsync()
        {
            if (!_isCloudTimeline || !CanRetryCloudSearch || IsLibraryLoading || _libraryCts == null) return;
            if (_cloud == null || !CloudConnected) return;
            IsLibraryLoading = true;
            LibraryLoadStatus = "Retrying cloud search…";
            // Keep the failed page/cursor and query. Already loaded pages and
            // the date range must not be lost when recovering a network error.
            await LoadTimelinePageAsync(_libraryCts);
        }

        private async Task LoadTimelinePageAsync(CancellationTokenSource owner)
        {
            CanRetryCloudSearch = false;
            var client = _cloud!;
            try
            {
                var page = await client.SearchAsync(_timelineQuery!, _timelinePage, _timelineCursor, owner.Token);
                if (_libraryCts != owner || owner.IsCancellationRequested) return;
                if (page == null) throw new InvalidOperationException("The server could not load the timeline.");
                var items = page.NewPhotos(AllPhotos.Select(photo => photo.FilePath))
                    .Select(CloudPhotoMapper.FromTimeline).ToList();
                AllPhotos.AddRange(items);
                _timelineCursor = page.CursorPaging ? page.NextCursor : null;
                _timelinePage = page.Page + 1;
                HasMoreTimeline = page.CursorPaging ? !string.IsNullOrEmpty(_timelineCursor)
                    : page.Results.Length > 0 && (long)_timelinePage * page.Limit < page.Total;
                ApplyFilters();
                FinishBrowse(owner, AllPhotos.Count == 0 ? "No photos match these filters." : string.Empty);
                _ = RefreshSearchFacetsAsync(owner, _timelineQuery!);
                _ = Task.Run(() => HydrateCloudThumbnailsAsync(items, owner.Token), owner.Token);
            }
            catch (OperationCanceledException) when (owner.IsCancellationRequested) { }
            catch (HttpRequestException error)
            {
                var message = error.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden
                    ? "Sign in to Maple Cloud to search."
                    : error.StatusCode == null ? "Cloud search is offline. Retry when connected."
                    : "Cloud search failed. Retry to try again.";
                FailCloudSearch(owner, message);
            }
            catch (OperationCanceledException)
            {
                FailCloudSearch(owner, "Cloud search timed out. Retry to try again.");
            }
            catch (Exception)
            {
                FailCloudSearch(owner, "Could not load cloud search. Retry to try again.");
            }
        }

        private void FailCloudSearch(CancellationTokenSource owner, string message)
        {
            if (_libraryCts != owner || owner.IsCancellationRequested || !_isCloudTimeline) return;
            CanRetryCloudSearch = true;
            FinishBrowse(owner, message);
        }

        public CloudSearchQuery CurrentTimelineQuery() => new()
        {
            Text = SearchText.Trim(),
            Scope = CloudSearchScope,
            MinimumRating = MinRatingFilter > 0 ? MinRatingFilter : null,
            Flag = FlagFilter == "all" ? null : FlagFilter,
            Color = ColorFilter == "all" ? null : ColorFilter,
            People = CloudPeopleFilter,
            Places = CloudPlaceFilter,
            Hidden = CloudHiddenFilter,
            Owner = CloudOwnerFilter.Length > 0 ? CloudOwnerFilter : null,
            Extension = FormatFilter == "All" ? null : FormatFilter.ToLowerInvariant(),
            From = DateFilterStart is { } start ? new DateTimeOffset(DateTime.SpecifyKind(start, DateTimeKind.Utc)) : null,
            Through = DateFilterEndExclusive is { } end ? new DateTimeOffset(DateTime.SpecifyKind(end.AddMilliseconds(-1), DateTimeKind.Utc)) : null,
            Sort = PhotoSort switch
            {
                BrowseSort.CapturedNewest => CloudSearchSort.CapturedDescending,
                BrowseSort.CapturedOldest => CloudSearchSort.CapturedAscending,
                BrowseSort.Rating => CloudSearchSort.Rating,
                _ => CloudSearchSort.Name,
            },
        };

        private bool RestartTimelineForChangedFilters()
        {
            if (!_isCloudTimeline || _timelineQuery == null) return false;
            var query = CurrentTimelineQuery();
            if (query == _timelineQuery) return false;
            _libraryCts?.Cancel();
            var owner = _libraryCts = new CancellationTokenSource();
            _timelineQuery = query;
            _timelinePage = 0;
            _timelineCursor = null;
            HasMoreTimeline = false;
            CanRetryCloudSearch = false;
            SelectedPhoto = null;
            SyncSelectedPhotos(Array.Empty<PhotoItem>());
            AllPhotos.Clear();
            Photos.Clear();
            PhotoGroups.Clear();
            HasPhotos = false;
            IsLibraryLoading = true;
            LibraryLoadStatus = "Searching Maple Cloud…";
            _ = ReloadTimelineAfterDebounceAsync(owner);
            return true;
        }

        private async Task ReloadTimelineAfterDebounceAsync(CancellationTokenSource owner)
        {
            try
            {
                await Task.Delay(300, owner.Token);
                if (_libraryCts != owner || !_isCloudTimeline) return;
                if (_cloud == null || !CloudConnected)
                {
                    FinishBrowse(owner, "Connect to Maple Cloud to search.");
                    return;
                }
                await LoadTimelinePageAsync(owner);
            }
            catch (OperationCanceledException) when (owner.IsCancellationRequested) { }
        }

    }
}

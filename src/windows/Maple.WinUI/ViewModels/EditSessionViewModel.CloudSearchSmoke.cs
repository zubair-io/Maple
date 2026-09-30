using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    // Runs only through the explicit native lifecycle diagnostic. The real
    // view model and dispatcher are used; only HTTP responses are controlled.
    internal static async Task VerifyCloudSearchAsync(string output)
    {
        using var handler = new SearchResponses();
        using var client = new CloudClient("https://search.invalid", handler, Path.Combine(output, "search-cache"));
        var session = new EditSessionViewModel(restoreSources: false) { _cloud = client, CloudConnected = true };
        static HttpResponseMessage Page(string name, bool cursor, string? next, int page, int total) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(System.Text.Json.JsonSerializer.Serialize(new
            {
                results = new[] { new { filename = name, abs_path = "/photos/" + name, mtime = 0 } },
                cursorPaging = cursor, nextCursor = next, page, total, limit = 200,
            })),
        };
        static void Require(bool value, string reason)
        {
            if (!value) throw new InvalidOperationException("Cloud search: " + reason);
        }
        async Task Wait(Func<bool> condition)
        {
            var end = Environment.TickCount64 + 10000;
            while (!condition() && Environment.TickCount64 < end) await Task.Delay(20);
            Require(condition(), "timed out waiting for search state");
        }
        try
        {
            session.PhotoSort = BrowseSort.CapturedNewest;
            handler.Next().SetResult(Page("first.dng", true, "after-200", 0, 600));
            await session.LoadCloudTimelineAsync();
            Require(session.HasMoreTimeline, "capture cursor was not retained");
            var stale = handler.Next();
            var loadingOldPage = session.LoadMoreTimelineAsync();
            var current = handler.Next();
            session.SearchText = "beyond first 200";
            await Wait(() => handler.Queries.Count == 3);
            Require(handler.Queries[2].Contains("placeQuery=beyond%20first%20200")
                && handler.Queries[2].Contains("page=0") && !handler.Queries[2].Contains("cursor="), "query did not reset paging");
            current.SetResult(Page("match-outside-loaded-page.dng", false, null, 0, 201));
            await Wait(() => !session.IsLibraryLoading);
            stale.SetResult(Page("obsolete.dng", true, null, 1, 600));
            await loadingOldPage;
            Require(session.Photos.Count == 1 && session.Photos[0].FileName == "match-outside-loaded-page.dng",
                "late page replaced search or local substring filtering removed server match");
            Require(session.HasMoreTimeline, "text search did not continue with page paging");
            handler.Next().SetResult(Page("match-outside-loaded-page.dng", false, null, 1, 201));
            await session.LoadMoreTimelineAsync();
            Require(handler.Queries[^1].Contains("page=1") && !session.HasMoreTimeline && session.Photos.Count == 1,
                "page continuation or deduplication failed");
            var filtered = handler.Next();
            session.MinRatingFilter = 4;
            await Wait(() => handler.Queries.Count == 5);
            Require(handler.Queries[^1].Contains("rating=4") && handler.Queries[^1].Contains("page=0"), "rating stayed local");
            filtered.SetResult(new(HttpStatusCode.ServiceUnavailable));
            await Wait(() => !session.IsLibraryLoading);
            Require(session.LibraryLoadStatus.Contains("failed") && session.Photos.Count == 0, "failure was presented as a result");
            Require(session.CanRetryCloudSearch, "failed search did not offer retry");
            var failedQuery = handler.Queries[^1];
            handler.Next().SetResult(Page("recovered.dng", false, null, 0, 1));
            await session.RetryCloudSearchAsync();
            Require(handler.Queries[^1] == failedQuery && session.Photos.Count == 1 && !session.CanRetryCloudSearch,
                "retry lost filters or did not recover");
            await Wait(() => session.SearchFacets?.People?.Length == 1);
            var facetsPage = handler.Next();
            session.CloudPeopleFilter = "Ada";
            session.CloudPlaceFilter = "Paris, France";
            session.CloudHiddenFilter = Services.Cloud.CloudHiddenFilter.Only;
            session.ColorFilter = "red";
            await Wait(() => handler.Queries.Count == 7);
            Require(handler.Queries[^1].Contains("people=Ada") && handler.Queries[^1].Contains("place=Paris%2C%20France")
                && handler.Queries[^1].Contains("hidden=only") && handler.Queries[^1].Contains("color=red"),
                "facet changes did not reach the server together");
            facetsPage.SetResult(Page("facet-match.dng", false, null, 0, 1));
            await Wait(() => !session.IsLibraryLoading);
        }
        finally
        {
            session.Dispose();
            await session.Renderer.StopAsync();
        }
    }

    private sealed class SearchResponses : HttpMessageHandler
    {
        private readonly Queue<TaskCompletionSource<HttpResponseMessage>> _responses = new();
        public List<string> Queries { get; } = new();
        public TaskCompletionSource<HttpResponseMessage> Next()
        {
            var result = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
            _responses.Enqueue(result);
            return result;
        }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath == "/api/search/facets")
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("""{"total":1,"people":[{"value":"Ada","count":1}],"places":[{"value":"Paris, France","count":1}],"supportedFilters":["people","place","hidden"]}"""),
                });
            if (request.RequestUri!.AbsolutePath != "/api/search") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            Queries.Add(request.RequestUri.Query);
            // Deliberately ignore cancellation to verify the generation guard.
            return _responses.Dequeue().Task;
        }
    }
}

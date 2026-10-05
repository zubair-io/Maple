using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Controls;
using Maple.WinUI.Services.Cloud;
using Microsoft.UI.Xaml;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyCloudMapAsync(string output)
    {
        var styleName = "qualification-" + Guid.NewGuid().ToString("N") + ".json";
        var stylePath = Path.Combine(AppContext.BaseDirectory, "Assets", "Map", styleName);
        await File.WriteAllTextAsync(stylePath, """{"version":8,"sources":{},"layers":[{"id":"background","type":"background","paint":{"background-color":"#151311"}}]}""");
        var handler = new MapSmokeHandler();
        using var client = new CloudClient("https://map-test.invalid", handler, Path.Combine(output, "map-cache"));
        using var map = new CloudMapView(client, new() { TileUrl = "https://maple-map.invalid/" + styleName }, new());
        map.QualificationDiagnostic += line => File.AppendAllText(Path.Combine(output, "map-publication.jsonl"), line + Environment.NewLine);
        try
        {
            SetMode(ShellMode.Browse);
            BrowseGridContainer.Visibility = Visibility.Collapsed;
            CloudMapContainer.Children.Add(map);
            CloudMapContainer.Visibility = Visibility.Visible;
            RecordSmokeStage(output, "map-host-loading");
            await WaitAsync(() => map.HostReady && map.AppliedCellCount == 1, "MapLibre host did not request and apply real viewport cells");
            RecordSmokeStage(output, "map-host-ready");
            if (!handler.Query.Contains("bbox=") || !handler.Query.Contains("zoom="))
                throw new InvalidOperationException("Map viewport request was not bounded");
            RecordSmokeStage(output, "map-filter-refresh");
            map.SetQuery(new() { MinimumRating = 4 });
            await WaitAsync(() => handler.Query.Contains("rating=4") && map.AppliedCellCount == 1, "Map filters did not refresh viewport cells");
            var settledRequests = handler.RequestCount;
            await Task.Delay(1000);
            if (handler.RequestCount > settledRequests + 1 || map.AppliedCellCount != 1)
                throw new InvalidOperationException($"Map publication did not remain settled: requests={handler.RequestCount}, "
                    + $"settledRequests={settledRequests}, appliedCells={map.AppliedCellCount}; inspect map-publication.jsonl");
            RecordSmokeStage(output, "map-duplicate-viewport");
            var publishedViewport = map.Viewport ?? throw new InvalidOperationException("Map viewport missing");
            var publishedRequests = handler.RequestCount;
            for (var duplicate = 0; duplicate < 50; duplicate++)
            {
                map.UpdateViewport(publishedViewport);
                if (map.AppliedCellCount != 1)
                    throw new InvalidOperationException("Duplicate viewport cleared published Map cells");
            }
            await Task.Delay(250);
            if (handler.RequestCount != publishedRequests || map.AppliedCellCount != 1)
                throw new InvalidOperationException("Duplicate viewport restarted the settled Map request");
            RecordSmokeStage(output, "map-server-failure");
            handler.Status = HttpStatusCode.ServiceUnavailable;
            map.SetQuery(new() { MinimumRating = 1 });
            await WaitAsync(() => map.CanRetry, "Map failure did not expose retry");
            var failedRequests = handler.RequestCount;
            await Task.Delay(1000);
            if (handler.RequestCount > failedRequests + 1 || !map.CanRetry)
                throw new InvalidOperationException("Map server failure repeatedly resized and restarted requests");
            handler.Status = HttpStatusCode.OK;
            await map.RetryAsync();
            await WaitAsync(() => map.AppliedCellCount == 1 && !map.CanRetry, "Map retry did not recover the same viewport");
            if (!handler.Query.Contains("rating=1")) throw new InvalidOperationException("Map retry lost query filters");

            RecordSmokeStage(output, "map-auth-failure");
            handler.Status = HttpStatusCode.Unauthorized;
            map.SetQuery(new() { MinimumRating = 2 });
            await WaitAsync(() => map.StatusText.Contains("Sign in"), "Map authentication failure was not distinct");
            // A 401 refreshes auth and retries the HTTP request once. Count
            // viewport generations, independent of that transport recovery.
            var authRequests = map.RequestGeneration;
            await Task.Delay(1000);
            if (map.RequestGeneration > authRequests + 1 || !map.StatusText.Contains("Sign in") || !map.CanRetry)
                throw new InvalidOperationException($"Map sign-in failure did not settle: generation={map.RequestGeneration}, "
                    + $"initialGeneration={authRequests}, retry={map.CanRetry}, status={map.StatusText}");
            handler.Status = HttpStatusCode.OK;
            handler.Empty = true;
            map.SetQuery(new() { MinimumRating = 3 });
            await WaitAsync(() => map.StatusText.Contains("No photos with a location"), "Empty locations were not distinct from loading");
            handler.Empty = false;

            RecordSmokeStage(output, "map-stale-query");
            map.SetQuery(new() { MinimumRating = 5 });
            await handler.HeldEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            map.SetQuery(new() { MinimumRating = 4 });
            await WaitAsync(() => map.AppliedCellCount == 1, "Replacement map query did not complete");
            handler.HeldResponse.TrySetResult();
            await Task.Delay(100);
            // Footer resizing can start a fresh viewport request while the old
            // response completes. Wait through that loading state; the held
            // response has two cells, distinct from both loading and current data.
            await WaitAsync(() => map.AppliedCellCount > 0, "Current map results did not settle after delayed response");
            if (map.AppliedCellCount != 1) throw new InvalidOperationException("Late map response replaced current results");

            RecordSmokeStage(output, "map-responsive-bounds");
            await VerifyMapBoundsAsync(map);
            RecordSmokeStage(output, "map-navigation-state");
            var camera = map.Viewport;
            CloudMapContainer.Visibility = Visibility.Collapsed;
            CloudMapContainer.Visibility = Visibility.Visible;
            await Task.Delay(200);
            if (!map.HostReady || map.Viewport != camera)
                throw new InvalidOperationException($"Map host lost camera across navigation: ready={map.HostReady}; "
                    + $"before={camera}; after={map.Viewport}");
        }
        finally
        {
            RecordSmokeStage(output, "map-dispose");
            CloudMapContainer.Children.Remove(map);
            SetMode(ShellMode.Browse);
            File.Delete(stylePath);
        }

        static async Task WaitAsync(Func<bool> predicate, string error)
        {
            var deadline = DateTime.UtcNow.AddSeconds(30);
            while (!predicate())
            {
                if (DateTime.UtcNow >= deadline) throw new TimeoutException(error);
                await Task.Delay(50);
            }
        }
    }

    private async Task VerifyMapBoundsAsync(CloudMapView map)
    {
        var root = (FrameworkElement)Content;
        var originalWidth = root.Width;
        var originalHeight = root.Height;
        try
        {
            foreach (var size in new[] { (1024d, 768d), (720d, 450d), (512d, 384d) })
            {
                root.Width = size.Item1;
                root.Height = size.Item2;
                root.UpdateLayout();
                await Task.Delay(80);
                root.UpdateLayout();
                var back = map.BackControl;
                var bounds = back.TransformToVisual(root).TransformBounds(new Windows.Foundation.Rect(0, 0, back.ActualWidth, back.ActualHeight));
                if (bounds.Left < 0 || bounds.Top < 0 || bounds.Right > size.Item1 || bounds.Bottom > size.Item2
                    || bounds.Width < 24 || bounds.Height < 24 || map.CanvasHeight < 24)
                    throw new InvalidOperationException($"Map controls overflow or consume the canvas at {size}");
            }
        }
        finally
        {
            root.Width = originalWidth;
            root.Height = originalHeight;
            root.UpdateLayout();
            await Task.Delay(600);
        }
    }

    private sealed class MapSmokeHandler : HttpMessageHandler
    {
        public string Query = "";
        public int RequestCount;
        public HttpStatusCode Status = HttpStatusCode.OK;
        public bool Empty;
        public TaskCompletionSource HeldEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource HeldResponse = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Query = request.RequestUri!.Query;
            Interlocked.Increment(ref RequestCount);
            if (Query.Contains("rating=5"))
            {
                HeldEntered.TrySetResult();
                await HeldResponse.Task;
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("""{"cells":[{"lat":10,"lng":0,"count":9,"representativeAssetId":"stale-one"},{"lat":15,"lng":0,"count":9,"representativeAssetId":"stale-two"}]}""") };
            }
            return new HttpResponseMessage(Status)
            {
                Content = new StringContent(Empty ? "{\"cells\":[]}" : """{"cells":[{"lat":20,"lng":0,"count":2,"representativeAssetId":"fixture","placeLabel":"Fixture place"}]}"""),
            };
        }
    }
}

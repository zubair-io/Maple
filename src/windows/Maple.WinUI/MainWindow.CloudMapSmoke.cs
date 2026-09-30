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
        try
        {
            SetMode(ShellMode.Browse);
            BrowseGridContainer.Visibility = Visibility.Collapsed;
            CloudMapContainer.Children.Add(map);
            CloudMapContainer.Visibility = Visibility.Visible;
            await WaitAsync(() => map.HostReady && map.AppliedCellCount == 1, "MapLibre host did not request and apply real viewport cells");
            if (!handler.Query.Contains("bbox=") || !handler.Query.Contains("zoom="))
                throw new InvalidOperationException("Map viewport request was not bounded");
            map.SetQuery(new() { MinimumRating = 4 });
            await WaitAsync(() => handler.Query.Contains("rating=4") && map.AppliedCellCount == 1, "Map filters did not refresh viewport cells");
            var settledRequests = handler.RequestCount;
            await Task.Delay(1000);
            if (handler.RequestCount > settledRequests + 1 || map.AppliedCellCount != 1)
                throw new InvalidOperationException("Map result layout repeatedly restarted viewport requests");
            CloudMapContainer.Visibility = Visibility.Collapsed;
            CloudMapContainer.Visibility = Visibility.Visible;
            if (!map.HostReady) throw new InvalidOperationException("Map host lost state across navigation");
        }
        finally
        {
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

    private sealed class MapSmokeHandler : HttpMessageHandler
    {
        public string Query = "";
        public int RequestCount;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Query = request.RequestUri!.Query;
            Interlocked.Increment(ref RequestCount);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"cells":[{"lat":20,"lng":0,"count":2,"representativeAssetId":"fixture","placeLabel":"Fixture place"}]}"""),
            });
        }
    }
}

using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    public sealed partial class CloudClient
    {
        public async Task<CloudTimelinePage> SearchAsync(CloudSearchQuery query, int page,
            string? cursor, CancellationToken ct, int limit = 200)
        {
            if (page < 0 || page > 10000) throw new ArgumentOutOfRangeException(nameof(page));
            if (limit < 1 || limit > 500) throw new ArgumentOutOfRangeException(nameof(limit));
            var paging = string.IsNullOrEmpty(cursor) ? $"&page={page}" : "&cursor=" + Uri.EscapeDataString(cursor);
            var route = "api/search?" + query.ToQueryString() + $"&limit={limit}" + paging;
            using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Get, route), ct);
            response.EnsureSuccessStatusCode();
            var result = await ReadJsonAsync<CloudTimelinePage>(response, ct)
                ?? throw new InvalidOperationException("Invalid search response");
            if (result.NotImplemented) throw new NotSupportedException("This search scope is not supported by the server.");
            return result;
        }

        public Task<CloudTimelinePage?> GetTimelineAsync(string? cursor, CancellationToken ct) =>
            GetJsonAsync<CloudTimelinePage>("api/search?sort=captured_desc&limit=200" +
                (string.IsNullOrEmpty(cursor) ? "" : $"&cursor={Uri.EscapeDataString(cursor)}"), ct);
    }

}

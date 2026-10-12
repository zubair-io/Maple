using System;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    public sealed partial class CloudClient
    {
        /// <summary>
        /// One page of a search. Pass the previous page's <see cref="CloudTimelinePage.RankPin"/>
        /// on a further page of a free-text search; when the engine it names cannot rank the page
        /// this throws <see cref="CloudRankEngineChangedException"/> and the caller restarts at page 0 (#4542).
        /// </summary>
        public async Task<CloudTimelinePage> SearchAsync(CloudSearchQuery query, int page,
            string? cursor, CancellationToken ct, int limit = 200, string? rankPin = null)
        {
            if (page < 0 || page > 10000) throw new ArgumentOutOfRangeException(nameof(page));
            if (limit < 1 || limit > 500) throw new ArgumentOutOfRangeException(nameof(limit));
            var paging = string.IsNullOrEmpty(cursor) ? $"&page={page}" : "&cursor=" + Uri.EscapeDataString(cursor);
            var pin = string.IsNullOrEmpty(rankPin) ? "" : "&rankPin=" + Uri.EscapeDataString(rankPin);
            var route = "api/search?" + query.ToQueryString() + $"&limit={limit}" + paging + pin;
            using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Get, route), ct);
            if (response.StatusCode == HttpStatusCode.Conflict && await IsRankEngineChangedAsync(response, ct))
                throw new CloudRankEngineChangedException();
            response.EnsureSuccessStatusCode();
            var result = await ReadJsonAsync<CloudTimelinePage>(response, ct)
                ?? throw new InvalidOperationException("Invalid search response");
            if (result.NotImplemented) throw new NotSupportedException("This search scope is not supported by the server.");
            if (!result.HasPagingMode || !result.HasResults || result.Results == null || result.Total < 0
                || result.Page < 0 || result.Page > 10000 || result.Limit < 1 || result.Limit > 500)
                throw new InvalidOperationException("Search response is missing valid pagination metadata.");
            return result;
        }

        private static async Task<bool> IsRankEngineChangedAsync(HttpResponseMessage response, CancellationToken ct)
        {
            try
            {
                using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
                return body.RootElement.ValueKind == JsonValueKind.Object
                    && body.RootElement.TryGetProperty("code", out var code)
                    && code.ValueKind == JsonValueKind.String
                    && code.GetString() == "rank_engine_changed";
            }
            catch (JsonException) { return false; }
        }

        public Task<CloudTimelinePage?> GetTimelineAsync(string? cursor, CancellationToken ct) =>
            GetJsonAsync<CloudTimelinePage>("api/search?sort=captured_desc&limit=200" +
                (string.IsNullOrEmpty(cursor) ? "" : $"&cursor={Uri.EscapeDataString(cursor)}"), ct);
    }

    /// <summary>A pinned search page's engine could not rank it; restart the search at page 0 (#4542).</summary>
    public sealed class CloudRankEngineChangedException : Exception
    {
        public CloudRankEngineChangedException()
            : base("The ranking earlier pages came from is unavailable; restart from page 0.") { }
    }
}

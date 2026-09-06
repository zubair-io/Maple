using System;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud
{
    public sealed partial class CloudClient
    {
        public Task<CloudTimelinePage?> GetTimelineAsync(string? cursor, CancellationToken ct) =>
            GetJsonAsync<CloudTimelinePage>("api/search?sort=captured_desc&limit=200" +
                (string.IsNullOrEmpty(cursor) ? "" : $"&cursor={Uri.EscapeDataString(cursor)}"), ct);
    }

}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud;

internal static class CloudThumbnailFetch
{
    internal const int Width = 8;

    internal static async Task RunAsync<T>(IEnumerable<T> items, Func<T, Task> fetch, CancellationToken ct)
    {
        using var gate = new SemaphoreSlim(Width);
        var tasks = items.Select(async item =>
        {
            await gate.WaitAsync(ct);
            try
            {
                ct.ThrowIfCancellationRequested();
                await fetch(item);
            }
            finally { gate.Release(); }
        });
        try
        {
            await Task.WhenAll(tasks);
        }
        catch (OperationCanceledException)
        {
            // The folder changed mid-fetch; abandoning the remaining tiles is the normal end.
        }
    }
}

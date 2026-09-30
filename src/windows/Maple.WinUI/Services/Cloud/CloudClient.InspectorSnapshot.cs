using System;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud;

public sealed record CloudInspectorSnapshot(string? Xmp, bool SidecarUnavailable,
    CloudInspectorMetadata? Enrichment, bool EnrichmentUnavailable);

public sealed partial class CloudClient
{
    public async Task<CloudInspectorSnapshot> ReadInspectorAsync(string serverPath, CancellationToken cancellation)
    {
        var sidecar = ReadPartAsync(() => ReadMetadataXmpAsync(serverPath, cancellation), cancellation);
        var enrichment = ReadPartAsync(() => GetInspectorMetadataAsync(serverPath, cancellation), cancellation);
        await Task.WhenAll(sidecar, enrichment).ConfigureAwait(false);
        cancellation.ThrowIfCancellationRequested();
        return new(sidecar.Result.Value, sidecar.Result.Unavailable,
            enrichment.Result.Value, enrichment.Result.Unavailable || enrichment.Result.Value == null);
    }

    private static async Task<(T? Value, bool Unavailable)> ReadPartAsync<T>(Func<Task<T?>> read,
        CancellationToken cancellation) where T : class
    {
        try { return (await read().ConfigureAwait(false), false); }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
        catch (Exception error) when (error is System.Net.Http.HttpRequestException or System.IO.IOException
            or System.Text.Json.JsonException or OperationCanceledException)
        {
            DiagLog.Write($"[inspector] metadata part unavailable: {error.Message}");
            return (null, true);
        }
    }
}

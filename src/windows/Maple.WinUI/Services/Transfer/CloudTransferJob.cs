using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Generated;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.Services.Transfer;

internal sealed record CloudTransferJournal(int Version, string Server, string Id, string? PendingRoute,
    JsonElement PendingPayload, Dictionary<string, string> Names);

/// <summary>#3880: persist the submission identity before HTTP so a lost response
/// can be retried idempotently. The server owns per-photo writes and recovery.</summary>
public sealed class CloudTransferJob
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string _path;
    private readonly CloudClient _client;
    private CloudTransferJournal _journal;
    private readonly SemaphoreSlim _gate = new(1, 1);
    public string Id => _journal.Id;
    public string StorageId => Path.GetFileNameWithoutExtension(_path);
    public IReadOnlyDictionary<string, string> Names => _journal.Names;
    public bool SubmissionPending => _journal.PendingRoute != null;
    public CloudClient Client => _client;
    private CloudTransferJob(string path, CloudClient client, CloudTransferJournal journal) => (_path, _client, _journal) = (path, client, journal);

    public static async Task<CloudTransferJob> PrepareAsync(string root, CloudClient client,
        IReadOnlyList<CloudTransferTarget> targets, IReadOnlyDictionary<string, string> names,
        AdjustmentTransferPatch patch, WhiteBalanceBaseline? correction = null)
    {
        if (targets.Count == 0 || targets.Select(t => t.Id).Distinct().Count() != targets.Count)
            throw new InvalidDataException("Select distinct cloud target photos.");
        if (targets.Any(t => string.IsNullOrWhiteSpace(t.Path) || !names.ContainsKey(t.Id)))
            throw new InvalidDataException("A cloud target is missing its path or display name.");
        if (correction is { } delta && (!double.IsFinite(delta.Temperature) || !double.IsFinite(delta.Tint)))
            throw new InvalidDataException("White balance correction must be finite.");
        if (correction.HasValue && !patch.WhiteBalanceScaleVersion.HasValue)
            throw new InvalidDataException("Select the white balance group before applying a relative correction.");
        var wire = XmpTransferPatch.Build(patch);
        if (correction.HasValue) wire.Attributes["papp:WbScaleVersion"] = AdjustmentFields.CurrentWhiteBalanceScaleVersion.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var id = NewId();
        // Omit relativeWhiteBalance completely for absolute mode: the server
        // treats explicit null as an invalid correction rather than omission.
        var payload = new Dictionary<string, object?> { ["targets"] = targets, ["patch"] = wire };
        if (correction.HasValue) payload["relativeWhiteBalance"] = correction.Value;
        var request = JsonSerializer.SerializeToElement(new { kind = "batch_adjustment_sync", requestId = id, payload }, Json);
        Directory.CreateDirectory(root);
        var journal = new CloudTransferJournal(1, client.ServerUrl, id, "api/jobs", request, new(names));
        var job = new CloudTransferJob(Path.Combine(root, id + ".json"), client, journal);
        await job.SaveAsync(journal);
        return job;
    }

    public static async Task<CloudTransferJob> OpenAsync(string root, string id, CloudClient client)
    {
        CloudClient.ValidateTransferId(id);
        var path = Path.Combine(root, id + ".json");
        var journal = JsonSerializer.Deserialize<CloudTransferJournal>(await File.ReadAllTextAsync(path), Json)
            ?? throw new InvalidDataException("Invalid saved transfer job.");
        if (journal.Version != 1 || journal.Server != client.ServerUrl)
            throw new InvalidDataException("Reconnect to the original server to recover this transfer.");
        CloudClient.ValidateTransferId(journal.Id);
        return new(path, client, journal);
    }

    public async Task SubmitPendingAsync(CancellationToken cancellation)
    {
        await _gate.WaitAsync(cancellation);
        try
        {
            using var lease = AcquireLease();
            await ReloadAsync();
            await SubmitCoreAsync(cancellation);
        }
        finally { _gate.Release(); }
    }

    private async Task SubmitCoreAsync(CancellationToken cancellation)
    {
        if (_journal.PendingRoute is not { } route) return;
        string id;
        try { id = await _client.SubmitTransferJobAsync(route, _journal.PendingPayload, cancellation); }
        catch (HttpRequestException error) when (error.StatusCode == HttpStatusCode.Conflict && route.EndsWith("/resume", StringComparison.Ordinal))
        {
            // Resume may have succeeded before its response was lost. Unlike
            // create/retry, this route has no request-id replay response.
            var current = await ReadAsync(cancellation);
            if (current.Status is not ("queued" or "running" or "done")) throw;
            id = current.Id;
        }
        if (id != _journal.Id) throw new InvalidDataException("The server returned a different transfer identity. Reconnect before continuing.");
        var acknowledged = _journal with { PendingRoute = null };
        await SaveAsync(acknowledged);
        _journal = acknowledged;
    }

    public Task<CloudTransferStatus> ReadAsync(CancellationToken cancellation) => _client.GetTransferJobAsync(Id, cancellation);
    public Task CancelAsync(CancellationToken cancellation) => _client.CancelTransferJobAsync(Id, cancellation);

    public async Task ContinueAsync(bool retryFailed, CancellationToken cancellation)
    {
        await _gate.WaitAsync(cancellation);
        try
        {
            using var lease = AcquireLease();
            await ReloadAsync();
            if (SubmissionPending) { await SubmitCoreAsync(cancellation); return; }
            var status = await ReadAsync(cancellation);
            if (status.Status is "queued" or "running")
                throw new InvalidOperationException("This transfer is already running. Wait for it before resuming or retrying.");
            var result = status.Result ?? status.Checkpoint;
            if (retryFailed ? result?.Failed.Length is not > 0 : result?.Remaining.Length is not > 0)
                throw new InvalidOperationException(retryFailed ? "There are no failed photos to retry." : "There are no pending photos to resume.");
            var nextId = retryFailed ? NewId() : Id;
            var pending = _journal with
            {
                Id = nextId,
                PendingRoute = $"api/jobs/{Id}/{(retryFailed ? "retry-failed" : "resume")}",
                PendingPayload = JsonSerializer.SerializeToElement(new { requestId = nextId }, Json)
            };
            await SaveAsync(pending);
            _journal = pending;
            await SubmitCoreAsync(cancellation);
        }
        finally { _gate.Release(); }
    }

    private FileStream AcquireLease() => new(_path + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    private async Task ReloadAsync()
    {
        var saved = await OpenAsync(Path.GetDirectoryName(_path)!, StorageId, _client);
        _journal = saved._journal;
    }

    private Task SaveAsync(CloudTransferJournal journal) => LocalTransferJob.WriteAtomicAsync(_path, JsonSerializer.Serialize(journal, Json));
    private static string NewId() => Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant();
}

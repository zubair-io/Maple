using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud;

public sealed record CloudTransferTarget(string Id, string Path);
public sealed record CloudTransferFailure(string Id, string Reason);
public sealed record CloudTransferResult(string[] Applied, CloudTransferFailure[] Failed, string[] Remaining, bool Cancelled);
public sealed record CloudTransferProgress(int Current, int Total);
public sealed record CloudTransferStatus(string Id, string Status, CloudTransferProgress Progress,
    CloudTransferResult? Checkpoint, CloudTransferResult? Result, string? Error);

public sealed partial class CloudClient
{
    public async Task<WhiteBalanceBaseline> GetTransferBaselineAsync(string path, CancellationToken cancellation)
    {
        using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Get,
            "api/jobs/batch-baseline?path=" + Uri.EscapeDataString(path)), cancellation);
        response.EnsureSuccessStatusCode();
        var pair = JsonSerializer.Deserialize<WhiteBalanceBaseline>(await response.Content.ReadAsStringAsync(cancellation), Json);
        if (!pair.IsValid) throw new InvalidDataException("The server returned an invalid camera white balance.");
        return pair;
    }

    public async Task<CloudTransferStatus> GetTransferJobAsync(string id, CancellationToken cancellation)
    {
        ValidateTransferId(id);
        using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Get, "api/jobs/" + id + "?summary=1"), cancellation);
        response.EnsureSuccessStatusCode();
        var job = JsonSerializer.Deserialize<CloudTransferStatus>(await response.Content.ReadAsStringAsync(cancellation), Json)
            ?? throw new InvalidDataException("The server returned an empty transfer job.");
        if (job.Id != id || job.Progress == null || job.Progress.Current < 0 || job.Progress.Total < job.Progress.Current ||
            job.Status is not ("queued" or "running" or "done" or "cancelled" or "failed"))
            throw new InvalidDataException("The server returned an invalid transfer job.");
        ValidateResult(job.Checkpoint);
        ValidateResult(job.Result);
        return job;
    }

    private static void ValidateResult(CloudTransferResult? result)
    {
        if (result != null && (result.Applied == null || result.Failed == null || result.Remaining == null ||
            result.Applied.Any(string.IsNullOrWhiteSpace) || result.Remaining.Any(string.IsNullOrWhiteSpace) ||
            result.Failed.Any(f => f == null || string.IsNullOrWhiteSpace(f.Id) || string.IsNullOrWhiteSpace(f.Reason))))
            throw new InvalidDataException("The server returned incomplete per-photo transfer results.");
    }

    internal async Task<string> SubmitTransferJobAsync(string route, JsonElement payload, CancellationToken cancellation)
    {
        if (route != "api/jobs")
        {
            var parts = route.Split('/');
            if (parts.Length != 4 || parts[0] != "api" || parts[1] != "jobs" || parts[3] is not ("resume" or "retry-failed"))
                throw new InvalidDataException("Unsupported transfer operation.");
            ValidateTransferId(parts[2]);
        }
        using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Post, route) { Content = JsonContent(payload) }, cancellation);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
        var id = json.RootElement.GetProperty("id").GetString() ?? "";
        ValidateTransferId(id);
        return id;
    }

    public async Task CancelTransferJobAsync(string id, CancellationToken cancellation)
    {
        ValidateTransferId(id);
        using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Post, $"api/jobs/{id}/cancel")
            { Content = JsonContent(new { }) }, cancellation);
        response.EnsureSuccessStatusCode();
    }

    internal static void ValidateTransferId(string id)
    {
        if (id.Length != 24 || id.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))))
            throw new InvalidDataException("Invalid transfer job identity.");
    }
}

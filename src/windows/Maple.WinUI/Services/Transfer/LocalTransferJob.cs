using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.Transfer;

public sealed record TransferJobInput(string Path, string Name, string ExpectedHash, AdjustmentTransferPatch Patch);
public sealed record TransferJobProgress(int Total, int Applied, int Failed, int Pending, string Current);
public sealed record TransferJobFailure(string Path, string Name, string Reason);
public sealed record TransferJobSummary(int Applied, int Pending, IReadOnlyList<TransferJobFailure> Failures, bool Cancelled);

internal sealed record TransferJobManifest(int Version, string Id, string[] Names);
internal sealed class TransferJobItem
{
    public TransferJobInput Input { get; set; } = null!;
    public string Status { get; set; } = "pending";
    public byte[]? Before { get; set; }
    public string? After { get; set; }
    public string? Error { get; set; }
}

/// <summary>Windows local sidecar delivery for #3880. Per-photo write-ahead files
/// bound memory and reconcile interruption after the atomic sidecar rename.
/// Cloud delivery uses the server's job protocol rather than this filesystem runner.</summary>
public sealed class LocalTransferJob
{
    private readonly string _directory;
    private readonly TransferJobManifest _manifest;
    public string Id => _manifest.Id;
    public int Count => _manifest.Names.Length;
    private LocalTransferJob(string directory, TransferJobManifest manifest) => (_directory, _manifest) = (directory, manifest);

    public static async Task<LocalTransferJob> CreateAsync(string root, IReadOnlyList<TransferJobInput> inputs,
        CancellationToken cancellation = default)
    {
        if (inputs.Count == 0) throw new InvalidDataException("Select at least one target photo.");
        var paths = inputs.Select(i => Path.GetFullPath(SidecarStore.SidecarPathFor(i.Path))).ToArray();
        if (paths.Distinct(StringComparer.OrdinalIgnoreCase).Count() != paths.Length)
            throw new InvalidDataException("Some selected photos share the same sidecar. Select only one of each pair.");
        var id = Guid.NewGuid().ToString("D");
        var directory = Path.Combine(root, id);
        Directory.CreateDirectory(directory);
        var manifest = new TransferJobManifest(1, id, inputs.Select(i => i.Name).ToArray());
        var job = new LocalTransferJob(directory, manifest);
        for (var index = 0; index < inputs.Count; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            var input = inputs[index] with { Path = Path.GetFullPath(inputs[index].Path) };
            if (string.Equals(input.Path, paths[index], StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("An XMP document cannot be a photo target.");
            AdjustmentTransfer.Apply(new XmpSidecarDocument(), input.Patch);
            await job.SaveItemAsync(index, new TransferJobItem { Input = input });
        }
        // Only a complete manifest advertises a recoverable job. Interrupted
        // preparation never writes any sidecar and cannot be resumed accidentally.
        await WriteAtomicAsync(Path.Combine(directory, "job.json"), JsonSerializer.Serialize(manifest));
        return job;
    }

    public static async Task<LocalTransferJob> OpenAsync(string root, string id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new InvalidDataException("Invalid transfer job identity.");
        var directory = Path.Combine(root, id);
        var manifest = JsonSerializer.Deserialize<TransferJobManifest>(await File.ReadAllTextAsync(Path.Combine(directory, "job.json")))
            ?? throw new InvalidDataException("Invalid transfer job.");
        if (manifest.Version != 1 || manifest.Id != id || manifest.Names == null)
            throw new InvalidDataException("Unsupported transfer job version or identity.");
        return new(directory, manifest);
    }

    public async Task<TransferJobSummary> RunAsync(bool retryFailed, CancellationToken cancellation,
        IProgress<TransferJobProgress>? progress = null)
    {
        // A restart or a second window cannot replay a job while its owner runs.
        using var lease = new FileStream(Path.Combine(_directory, "run.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var initial = await SummaryAsync();
        var appliedCount = initial.Applied;
        var failedCount = initial.Failures.Count;
        var pendingCount = initial.Pending;
        for (var index = 0; index < Count; index++)
        {
            if (cancellation.IsCancellationRequested) break;
            var item = await ReadItemAsync(index);
            if (item.Status == "applied" || (item.Status == "failed" && !retryFailed)) continue;
            if (retryFailed && item.Status != "failed") continue;
            var wasFailed = item.Status == "failed";
            try
            {
                // Cancellation is deliberately only observed between photos:
                // finish and acknowledge an in-flight write before stopping.
                await Task.Run(async () =>
                {
                    var current = SidecarStore.ReadSnapshot(item.Input.Path);
                    var hash = SidecarStore.SnapshotHash(current);
                    if (item.After == null)
                    {
                        if (hash != item.Input.ExpectedHash) throw new IOException("Conflict: the sidecar changed after preview.");
                        var document = current == null ? new XmpSidecarDocument() : XmpParser.Parse(Decode(current))
                            ?? throw new IOException("Existing sidecar is invalid; it was not overwritten.");
                        AdjustmentTransfer.Apply(document, item.Input.Patch);
                        item.Before = current;
                        item.After = XmpWriter.Serialize(document);
                        item.Status = "prepared";
                        item.Error = null;
                        await SaveItemAsync(index, item);
                    }
                    var afterHash = SidecarStore.SnapshotHash(Encoding.UTF8.GetBytes(item.After));
                    if (hash != afterHash && !SidecarStore.CompareExchange(item.Input.Path, item.Input.ExpectedHash, item.After))
                        throw new IOException("Conflict: a newer edit prevents this transfer from being written.");
                    item.Status = "applied";
                    item.Error = null;
                    await SaveItemAsync(index, item);
                });
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ArgumentException)
            {
                item.Status = "failed";
                item.Error = error.Message;
                await SaveItemAsync(index, item);
            }
            // Progress avoids rescanning all persisted entries for every write.
            if (wasFailed) failedCount--; else pendingCount--;
            if (item.Status == "applied") appliedCount++; else failedCount++;
            progress?.Report(new(Count, appliedCount, failedCount, pendingCount, item.Input.Name));
        }
        return await SummaryAsync(cancellation.IsCancellationRequested);
    }

    public async Task<TransferJobSummary> SummaryAsync(bool cancelled = false)
    {
        var applied = 0;
        var pending = 0;
        var failed = new List<TransferJobFailure>();
        for (var index = 0; index < Count; index++)
        {
            var item = await ReadItemAsync(index);
            if (item.Status == "applied") applied++;
            else if (item.Status == "failed") failed.Add(new(item.Input.Path, item.Input.Name, item.Error ?? "Transfer failed."));
            else pending++;
        }
        return new(applied, pending, failed, cancelled);
    }

    private async Task<TransferJobItem> ReadItemAsync(int index)
    {
        var item = JsonSerializer.Deserialize<TransferJobItem>(await File.ReadAllTextAsync(ItemPath(index)))
            ?? throw new InvalidDataException("Invalid transfer checkpoint.");
        if (item.Input == null || item.Status is not ("pending" or "prepared" or "applied" or "failed"))
            throw new InvalidDataException("Unsupported transfer checkpoint.");
        return item;
    }

    private string ItemPath(int index) => Path.Combine(_directory, index.ToString("D8") + ".json");
    private Task SaveItemAsync(int index, TransferJobItem item) => WriteAtomicAsync(ItemPath(index), JsonSerializer.Serialize(item));
    private static string Decode(byte[] bytes)
    {
        using var reader = new StreamReader(new MemoryStream(bytes), new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    private static async Task WriteAtomicAsync(string path, string content)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await file.WriteAsync(Encoding.UTF8.GetBytes(content));
                file.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally { try { File.Delete(temporary); } catch (IOException) { } }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Generated;

namespace Maple.WinUI.Services.Export;

/// <summary>One native render at a time. A prepared journal precedes every publication.</summary>
public sealed class ExportQueueRunner
{
    private readonly ExportQueueStore _store;
    private readonly IExportRecipeExecutor _executor;

    public ExportQueueRunner(ExportQueueStore store, IExportRecipeExecutor executor)
    {
        _store = store;
        _executor = executor;
    }

    public void ValidateRecipe(ExportRecipe recipe)
    {
        _executor.Validate(recipe);
        if (recipe.Destination != "directory" || recipe.Directory == null)
            throw new InvalidOperationException("Windows queues require a destination folder.");
        ExportPaths.DirectoryPath(recipe.Directory);
    }

    public ExportQueueJob Create(ExportRecipe recipe, IReadOnlyList<ExportInput> inputs,
        IEnumerable<string> protectedOriginals, CancellationToken cancellation = default)
    {
        ValidateRecipe(recipe);
        if (inputs.Count == 0) throw new InvalidOperationException("Select photos to export.");
        var directory = ExportPaths.DirectoryPath(recipe.Directory!);
        var id = Guid.NewGuid().ToString("N");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var entries = new List<ExportQueueItem>();
        for (var i = 0; i < inputs.Count; i++)
        {
            cancellation.ThrowIfCancellationRequested();
            var filename = _executor.Filename(recipe, inputs[i], (ulong)i);
            if (Path.GetFileName(filename) != filename || string.IsNullOrWhiteSpace(filename))
                throw new IOException("The naming template must produce a filename, not a path.");
            var output = Path.Combine(directory, filename);
            if (!names.Add(output))
                throw new IOException($"Multiple photos would write {filename}. Add {{n}} to the naming template.");
            entries.Add(new ExportQueueItem
            {
                Id = i.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Input = inputs[i] with { SourcePath = Path.GetFullPath(inputs[i].SourcePath) },
                SequenceIndex = (ulong)i,
                OutputPath = output,
                TempPath = ExportPaths.StagingPath(directory, id, (ulong)i),
            });
        }
        var job = new ExportQueueJob
        {
            Id = id, CreatedAt = DateTimeOffset.UtcNow, Recipe = recipe,
            ProtectedOriginals = protectedOriginals.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray(),
            Entries = entries,
        };
        var originals = ExportPaths.OriginalPaths(job);
        foreach (var item in entries)
        {
            cancellation.ThrowIfCancellationRequested();
            ExportPaths.ProtectOriginals(originals, item);
            try { item.SourceHash = ExportPaths.Hash(item.Input.SourcePath); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { item.Status = "failed"; item.Reason = $"Original read: {error.Message}"; }
        }
        cancellation.ThrowIfCancellationRequested();
        _store.Save(job);
        return job;
    }

    public Task<ExportQueueJob> RunAsync(string id, bool retryOnlyFailed,
        CancellationToken cancellation, Action<ExportQueueJob>? progress = null) => Task.Run(() =>
    {
        using var queueLease = _store.LockQueue();
        using var lease = _store.Lock(id);
        var job = _store.Load(id);
        _executor.Validate(job.Recipe);
        var originals = ExportPaths.OriginalPaths(job);
        ValidatePaths(job, originals);
        job.Cancelled = false;
        foreach (var item in job.Entries)
        {
            if (item.Status is "applied" or "skipped") continue;
            if (retryOnlyFailed && item.Status != "failed") continue;
            if (!retryOnlyFailed && item.Status == "failed") continue;
            if (cancellation.IsCancellationRequested) { job.Cancelled = true; break; }
            Process(job, item, originals, cancellation, progress);
            if (job.Cancelled) break;
        }
        SaveAndNotify(job, progress);
        return job;
    });

    private void ValidatePaths(ExportQueueJob job, HashSet<string> originals)
    {
        if (job.Recipe.Destination != "directory" || job.Recipe.Directory == null)
            throw new InvalidDataException("This queue requires a destination folder.");
        var directory = ExportPaths.DirectoryPath(job.Recipe.Directory);
        foreach (var item in job.Entries)
        {
            var expected = Path.Combine(directory, _executor.Filename(job.Recipe, item.Input, item.SequenceIndex));
            if (!string.Equals(expected, item.OutputPath, StringComparison.OrdinalIgnoreCase)
                || item.TempPath != ExportPaths.StagingPath(directory, job.Id, item.SequenceIndex))
                throw new InvalidDataException("Export paths no longer match the queued recipe.");
            ExportPaths.ProtectOriginals(originals, item);
        }
    }

    private void Process(ExportQueueJob job, ExportQueueItem item, HashSet<string> originals, CancellationToken cancel,
        Action<ExportQueueJob>? progress)
    {
        try
        {
            if (item.Status == "prepared" && RecoverPrepared(job, item, originals, cancel))
            {
                SaveAndNotify(job, progress);
                return;
            }
            // Interrupted renders have no complete output contract; remove only our own staging path.
            ExportPaths.DeleteStaging(item);
            var sourceHash = ExportPaths.Hash(item.Input.SourcePath);
            if (item.SourceHash != null && item.SourceHash != sourceHash)
                throw new IOException("Original changed since this export was queued. Create a new export.");
            item.SourceHash = sourceHash;
            item.BeforeHash = ExportPaths.ExistingHash(item.OutputPath);
            item.AfterHash = null;
            item.Reason = null;
            if (item.BeforeHash != null)
            {
                if (job.Recipe.OverwritePolicy == "skip") { item.Status = "skipped"; SaveAndNotify(job, progress); return; }
                if (job.Recipe.OverwritePolicy != "replace") throw new IOException($"Destination already exists: {item.OutputPath}");
            }
            item.Status = "rendering";
            SaveAndNotify(job, progress);
            _executor.Render(job.Recipe, item);
            if (cancel.IsCancellationRequested)
            {
                ExportPaths.DeleteStaging(item);
                item.Status = "pending";
                job.Cancelled = true;
                SaveAndNotify(job, progress);
                return;
            }
            if (ExportPaths.Hash(item.Input.SourcePath) != item.SourceHash)
                throw new IOException("Original changed during export. Create a new export.");
            item.AfterHash = ExportPaths.Hash(item.TempPath);
            item.Status = "prepared";
            SaveAndNotify(job, progress);
            if (cancel.IsCancellationRequested)
            {
                job.Cancelled = true;
                SaveAndNotify(job, progress);
                return;
            }
            Publish(job, item, originals);
            SaveAndNotify(job, progress);
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            // If journal persistence fails after the rename, retain the prepared
            // disk record so restart can recognize its committed output hash.
            if (item.Status == "applied") throw;
            item.Status = "failed";
            item.Reason = error.Message;
            try { ExportPaths.DeleteStaging(item); }
            catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException)
            { item.Reason += $" Staging cleanup failed: {cleanup.Message}"; }
            SaveAndNotify(job, progress);
        }
    }

    private bool RecoverPrepared(ExportQueueJob job, ExportQueueItem item, HashSet<string> originals,
        CancellationToken cancel)
    {
        if (item.AfterHash == null) throw new InvalidDataException("Prepared export has no output hash.");
        if (ExportPaths.ExistingHash(item.OutputPath) == item.AfterHash)
        {
            item.Status = "applied";
            ExportPaths.DeleteStaging(item);
            return true;
        }
        if (ExportPaths.ExistingHash(item.TempPath) != item.AfterHash)
            throw new IOException("Prepared export output is missing or changed. Retry the failed item to render it again.");
        if (cancel.IsCancellationRequested) { job.Cancelled = true; return true; }
        Publish(job, item, originals);
        return true;
    }

    private static void Publish(ExportQueueJob job, ExportQueueItem item, HashSet<string> originals)
    {
        ExportPaths.ProtectOriginals(originals, item);
        if (ExportPaths.ExistingHash(item.OutputPath) != item.BeforeHash)
            throw new IOException($"Destination changed while exporting: {item.OutputPath}");
        File.Move(item.TempPath, item.OutputPath, overwrite: job.Recipe.OverwritePolicy == "replace");
        item.Status = "applied";
    }

    private void SaveAndNotify(ExportQueueJob job, Action<ExportQueueJob>? progress)
    {
        _store.Save(job);
        progress?.Invoke(job);
    }
}

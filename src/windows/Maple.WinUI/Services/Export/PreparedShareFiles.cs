using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Generated;

namespace Maple.WinUI.Services.Export;

/// <summary>Owns only one fresh temporary share directory until Windows accepts it.</summary>
public sealed class PreparedShareFiles : IDisposable
{
    public string DirectoryPath { get; }
    private bool _handedOff;

    public PreparedShareFiles(string shareRoot)
    {
        DirectoryPath = Path.Combine(Path.GetFullPath(shareRoot), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(DirectoryPath);
    }

    public async Task<IReadOnlyList<string>> RenderEditedAsync(
        IReadOnlyList<ExportInput> inputs, ExportRecipe recipe, IExportRecipeExecutor executor,
        CancellationToken cancellation, Action<int, int>? progress = null)
    {
        cancellation.ThrowIfCancellationRequested();
        recipe = recipe with { Directory = DirectoryPath };
        await Task.Run(() => executor.Validate(recipe), cancellation);
        var paths = new List<string>();
        foreach (var input in inputs)
        {
            cancellation.ThrowIfCancellationRequested();
            progress?.Invoke(paths.Count + 1, inputs.Count);
            var sequence = (ulong)paths.Count + 1;
            var name = executor.Filename(recipe, input, sequence);
            if (string.IsNullOrWhiteSpace(name) || name != Path.GetFileName(name))
                throw new IOException("Share output must be a filename within its temporary directory.");
            var output = Path.Combine(DirectoryPath, name);
            var item = new ExportQueueItem { Id = Guid.NewGuid().ToString("N"), Input = input,
                SequenceIndex = sequence, OutputPath = output, TempPath = output };
            // Native rendering is synchronous. Cancel waits for this render,
            // then prevents both further renders and the Windows handoff.
            try { await Task.Run(() => executor.Render(recipe, item), cancellation); }
            catch (Exception error) when (error is not OperationCanceledException and not OutOfMemoryException)
            { throw new IOException($"Cannot prepare {input.OriginalStem} for sharing: {error.Message}", error); }
            cancellation.ThrowIfCancellationRequested();
            paths.Add(output);
        }
        return paths;
    }

    /// <summary>Receivers may read these files after the app window closes.</summary>
    public void RetainForReceiver() => _handedOff = true;

    public void Dispose()
    {
        if (_handedOff) return;
        // This path is an owned GUID child created above; never a source or
        // user-selected directory. Cleanup cannot replace the original error.
        try { if (Directory.Exists(DirectoryPath)) Directory.Delete(DirectoryPath, recursive: true); }
        catch (IOException error) { DiagLog.Write($"[share] temporary cleanup: {error.Message}"); }
        catch (UnauthorizedAccessException error) { DiagLog.Write($"[share] temporary cleanup: {error.Message}"); }
    }
}

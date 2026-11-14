using System;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

/// <summary>The editor's imported WB resolves (name-only Auto and single-axis reloads).
/// At most one runs at a time; a re-decode joins the estimate already in flight, and
/// navigation or close cancels the focused photo's estimate (#5922): a queued one never
/// starts, a running one stops inside the native call and releases its decoded RAW. A
/// request that becomes active on an already-decoded photo (paste, undo/redo, sidecar
/// reload) joins the same estimate, or reuses the pair it already landed for the same
/// request; a different request cancels the one it replaces.</summary>
public sealed class ImportedAutoEstimates
{
    private readonly object _lock = new();
    private readonly SemaphoreSlim _running = new(1, 1);
    private readonly Action<string, AdjustmentState, CancellationToken> _resolve;
    private string? _focus;
    private (string Path, ImportedWhiteBalance Request, Task<AdjustmentState?> Estimate, CancellationTokenSource Cancel)? _current;

    public ImportedAutoEstimates(Action<string, AdjustmentState, CancellationToken> resolve) => _resolve = resolve;

    /// <summary>True when a model change that re-decodes nothing makes an unresolved
    /// imported WB active: the decode path never sees it, so the editor starts or joins
    /// the resolver itself. A resolved pair or ordinary numeric WB needs no work.</summary>
    public static bool StartsWithoutDecode(AdjustmentState before, AdjustmentState after) =>
        after.ImportedWhiteBalance is { Resolved: null } && !RenderEngine.DecodeInputsChanged(before, after);

    /// <summary>The photo the editor decodes, or null when none. Changing it forgets the
    /// previous photo's estimate, so a later open of that photo estimates again.</summary>
    public void Focus(string? path)
    {
        lock (_lock)
        {
            if (_focus == path) return;
            _focus = path;
            _current?.Cancel.Cancel();
            _current = null;
        }
    }

    /// <summary>The focused photo's one estimate: a resolved clone of
    /// <paramref name="model"/>, or null after a failure or once the photo lost focus.</summary>
    public Task<AdjustmentState?> ResolveAsync(string path, AdjustmentState model)
    {
        lock (_lock)
        {
            // A different request (e.g. a pasted scale) must not take another request's pair.
            var request = model.ImportedWhiteBalance! with { Resolved = null };
            if (_current is { } current && current.Path == path && current.Request == request)
                return current.Estimate;
            if (_focus != path) return Task.FromResult<AdjustmentState?>(null);
            _current?.Cancel.Cancel();
            var resolved = model.Clone();
            var cancel = new CancellationTokenSource();
            var estimate = Task.Run(() => RunAsync(path, resolved, cancel.Token));
            _current = (path, request, estimate, cancel);
            return estimate;
        }
    }

    private async Task<AdjustmentState?> RunAsync(string path, AdjustmentState model, CancellationToken cancellation)
    {
        await _running.WaitAsync().ConfigureAwait(false);
        try
        {
            if (cancellation.IsCancellationRequested) return null;
            _resolve(path, model, cancellation);
            return model;
        }
        catch (Exception)
        {
            // Failure or cancellation keeps As Shot on screen; the next open retries.
            return null;
        }
        finally
        {
            _running.Release();
        }
    }
}

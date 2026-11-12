using System;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

/// <summary>The editor's name-only imported Auto estimates (#4669). At most one runs at a
/// time, a re-decode of the focused photo joins the estimate already in flight, and
/// navigation drops a queued estimate before it decodes anything. A request that becomes
/// active on an already-decoded photo (paste, undo/redo, sidecar reload) joins the same
/// estimate, or reuses the pair it already landed for the same request. The native estimate cannot
/// be cancelled yet (#5922): one that already started runs to its end and the editor's
/// generation guard ignores its result.</summary>
public sealed class ImportedAutoEstimates
{
    private readonly object _lock = new();
    private readonly SemaphoreSlim _running = new(1, 1);
    private readonly Action<string, AdjustmentState> _resolve;
    private string? _focus;
    private (string Path, ImportedWhiteBalance Request, Task<AdjustmentState?> Estimate)? _current;

    public ImportedAutoEstimates(Action<string, AdjustmentState> resolve) => _resolve = resolve;

    /// <summary>True when a model change that re-decodes nothing makes unresolved name-only
    /// Auto active: the decode path never sees it, so the editor starts or joins the estimate
    /// itself. A pair or a numeric WB is never estimated again.</summary>
    public static bool StartsWithoutDecode(AdjustmentState before, AdjustmentState after) =>
        ImportedWhiteBalanceResolver.IsUnresolvedAuto(after) && !RenderEngine.DecodeInputsChanged(before, after);

    /// <summary>The photo the editor decodes, or null when none. Changing it forgets the
    /// previous photo's estimate, so a later open of that photo estimates again.</summary>
    public void Focus(string? path)
    {
        lock (_lock)
        {
            if (_focus == path) return;
            _focus = path;
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
            var resolved = model.Clone();
            var estimate = Task.Run(() => RunAsync(path, resolved));
            _current = (path, request, estimate);
            return estimate;
        }
    }

    private async Task<AdjustmentState?> RunAsync(string path, AdjustmentState model)
    {
        await _running.WaitAsync().ConfigureAwait(false);
        try
        {
            lock (_lock)
            {
                if (_focus != path) return null;
            }
            _resolve(path, model);
            return model;
        }
        catch (Exception)
        {
            // Failure keeps As Shot on screen; the next open retries.
            return null;
        }
        finally
        {
            _running.Release();
        }
    }
}

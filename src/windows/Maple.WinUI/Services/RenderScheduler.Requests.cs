using System.Threading;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    public void RequestRender(AdjustmentState snapshot)
    {
        // Partial imports have neither a complete pair nor current-scale coordinates.
        // Keep the prior canvas; publication resubmits the live model, including edits.
        if (snapshot.ImportedWhiteBalance is { Resolved: null } imported
            && (imported.Temperature != null || imported.Tint != null)) return;
        var requestedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        lock (_gate)
        {
            if (_stopping) return;
            _pending = snapshot;
            _requestStarted = requestedAt;
            _pendingHistogram = null;
            _scopes.Invalidate();
        }
        InvalidateDetail();
        ScopeInvalidated?.Invoke();
        try { _signal.Release(); } catch (SemaphoreFullException) { }
    }
}

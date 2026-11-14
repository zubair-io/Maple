using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

// Runs the production submission method without starting CPU/GPU worker threads.
public sealed partial class RenderScheduler
{
    private readonly object _gate = new();
    private readonly SemaphoreSlim _signal = new(0, 1);
    private readonly bool _stopping = false;
    private AdjustmentState? _pending;
    private object? _pendingHistogram = null;
    private long _requestStarted;
    private readonly ScopeInvalidations _scopes = new();
    public event Action? ScopeInvalidated;
    public int DetailInvalidations { get; private set; }
    private void InvalidateDetail() => DetailInvalidations++;
    public object? PendingHistogram => _pendingHistogram;
    public AdjustmentState? Pending => _pending;
    public int QueuedSignals => _signal.CurrentCount;

    private sealed class ScopeInvalidations
    {
        public int Count { get; private set; }
        public void Invalidate() => Count++;
    }
}

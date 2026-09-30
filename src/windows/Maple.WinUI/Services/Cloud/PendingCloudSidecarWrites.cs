using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud;

/// <summary>Ordered autosaves retained until acknowledged. A failed write
/// pauses later writes; retry must not replay an older snapshot after a newer
/// one. The metadata dialog drains this queue before reading its preview.</summary>
public sealed class PendingCloudSidecarWrites
{
    private readonly object _gate = new();
    private readonly Queue<Func<Task>> _pending = new();
    private Task _worker = Task.CompletedTask;
    private bool _running;
    private Exception? _error;
    public event Action<Exception>? Failed;

    public void Enqueue(Func<Task> write)
    {
        lock (_gate)
        {
            _pending.Enqueue(write);
            if (!_running && _error == null) StartLocked();
        }
    }

    private void StartLocked()
    {
        _running = true;
        _error = null;
        _worker = Task.Run(RunAsync);
    }

    private async Task RunAsync()
    {
        while (true)
        {
            Func<Task> write;
            lock (_gate)
            {
                if (_pending.Count == 0) { _running = false; return; }
                write = _pending.Peek();
            }
            try { await write(); }
            catch (Exception error)
            {
                lock (_gate) { _error = error; _running = false; }
                Failed?.Invoke(error);
                return;
            }
            lock (_gate) _pending.Dequeue();
        }
    }

    public async Task DrainAsync(bool retryFailed = false)
    {
        Task worker;
        lock (_gate)
        {
            if (!_running && _pending.Count > 0 && (_error == null || retryFailed)) StartLocked();
            worker = _worker;
        }
        await worker;
        lock (_gate)
        {
            if (_error != null) throw new InvalidOperationException("Pending cloud save failed: " + _error.Message, _error);
        }
    }
}

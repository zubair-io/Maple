using System;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    private readonly ScopeSampleTracker _scopes = new();
    private readonly Task _scopeLoopTask;
    private ScopeReadback? _cpuScopeReadback, _gpuScopeReadback;
    private long _scopeFailedVersion = -1;
    /// <summary>Each emitted snapshot owns its arrays; subscribers may retain it.</summary>
    public event Action<ScopePanelFrame>? ScopeReady;
    public event Action? ScopeInvalidated;
    public event Action<long, string>? ScopeFailed;

    public void SetScopesEnabled(bool enabled)
    {
        lock (_gate)
        {
            if (_stopping || _scopes.Enabled == enabled) return;
            _scopes.SetEnabled(enabled);
            // The already-selected document needs one settled render when opened.
            if (enabled && _pending == null) _pending = _lastRendered;
        }
        ScopeInvalidated?.Invoke();
        try { _signal.Release(); } catch (SemaphoreFullException) { }
    }

    public bool IsScopeCurrent(long version)
    {
        lock (_gate) return !_stopping && _scopes.IsCurrent(version);
    }

    private async Task ScopeLoopAsync()
    {
        try
        {
            while (true)
            {
                await Task.Delay(40, _cts.Token);
                PollScope();
            }
        }
        catch (OperationCanceledException) when (_cts.IsCancellationRequested) { }
    }

    private unsafe void PollScope()
    {
        long version = -1;
        ScopeReadback? buffer = null;
        // Never queue behind a present/decode holding the handle-lifetime gate.
        if (!Monitor.TryEnter(_gate)) return;
        try
        {
            if (_stopping || !_scopes.Enabled || !_gpuSessionOpen || _scopeFailedVersion == _scopes.Version) return;
            version = _scopes.Version;
            buffer = _gpuScopeReadback ??= new ScopeReadback();
            fixed (MapleGpuLiveSession* handle = &_gpuSession)
            {
                var rc = buffer.Poll(handle, out var frame);
                if (rc < 0 || rc == 99) throw new InvalidOperationException($"GPU scope failed ({rc}): {RawFfi.LastError()}");
                if (rc != 1 || !_scopes.TryAccept(frame, out version)) return;
            }
        }
        catch (Exception error)
        {
            _scopeFailedVersion = version;
            ScopeFailed?.Invoke(version, error.Message);
            return;
        }
        finally { Monitor.Exit(_gate); }
        try
        {
            var sample = buffer.Reduce(version);
            if (IsScopeCurrent(version)) ScopeReady?.Invoke(sample);
        }
        catch (Exception error) { ScopeFailed?.Invoke(version, error.Message); }
    }

    private void EmitCpuScope(DecodedImage image, AdjustmentState state, float[]? encoded)
    {
        long version;
        lock (_gate)
        {
            if (_stopping || !_scopes.Enabled || !ReferenceEquals(image, _image)
                || !ReferenceEquals(state, _lastRendered) || _pending != null || encoded == null) return;
            version = _scopes.Version;
        }
        try
        {
            var buffer = _cpuScopeReadback ??= new ScopeReadback();
            buffer.FromCpu(encoded, image.Width, image.Height);
            var sample = buffer.Reduce(version);
            if (IsScopeCurrent(version)) ScopeReady?.Invoke(sample);
        }
        catch (Exception error) { ScopeFailed?.Invoke(version, error.Message); }
    }
}

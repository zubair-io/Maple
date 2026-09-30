using System.Collections.Generic;

namespace Maple.WinUI.Services;

/// <summary>Maps native session-local scope frames to edit/image generations.
/// Owned under the scheduler gate; changing edits never resets native frame IDs.</summary>
public sealed class ScopeSampleTracker
{
    private readonly Dictionary<ulong, long> _pending = new();
    private ulong _nativeFrame;
    private ulong _lastAccepted;
    public long Version { get; private set; }
    public bool Enabled { get; private set; }

    public void SetEnabled(bool enabled)
    {
        if (Enabled == enabled) return;
        Enabled = enabled;
        Invalidate();
    }

    public void Invalidate()
    {
        Version++;
        _pending.Clear();
    }

    public void ResetSession()
    {
        Invalidate();
        _nativeFrame = 0;
        _lastAccepted = 0;
    }

    public void Submitted()
    {
        _nativeFrame++;
        if (Enabled) _pending[_nativeFrame] = Version;
        if (_nativeFrame > 2) _pending.Remove(_nativeFrame - 2);
    }

    public bool TryAccept(ulong frame, out long version)
    {
        var found = _pending.Remove(frame, out version);
        if (!found || !Enabled || version != Version || frame <= _lastAccepted) return false;
        _lastAccepted = frame;
        return true;
    }

    public bool IsCurrent(long version) => Enabled && version == Version;
}

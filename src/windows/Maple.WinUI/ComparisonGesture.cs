namespace Maple.WinUI;

/// <summary>Matches the shared editor's 300ms tap/hold contract. Transient UI state only.</summary>
public sealed class ComparisonGesture
{
    public const int HoldMilliseconds = 300;
    private long? _pressedAt;
    public bool Latched { get; private set; }
    public bool IsPressed => _pressedAt.HasValue;
    public bool ShowingBefore => Latched || IsPressed;
    public void Press(long now) { _pressedAt ??= now; }
    public void Release(long now)
    {
        if (_pressedAt is not { } start) return;
        _pressedAt = null;
        if (now - start < HoldMilliseconds) Latched = !Latched;
    }
    public void Cancel() => _pressedAt = null;
    public void Toggle() => Latched = !Latched;
    public void Reset() { Cancel(); Latched = false; }
}

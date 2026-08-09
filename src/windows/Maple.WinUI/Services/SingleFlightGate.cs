// SingleFlightGate.cs — a reusable "only one of these running at a time"
// guard for an async UI flow that opens a ContentDialog (#2743 review
// finding). WinUI allows only ONE ContentDialog open at a time, so a
// re-entrant invocation of a flow that opens one — key-repeat on a held
// key, a stray double-click, a second trigger landing in the gap between
// one dialog closing and the next presenting — throws inside the second
// ShowAsync() call. A fire-and-forget `_ = RunSomethingAsync()` entry point
// (a synchronous keyboard handler can't await) then silently swallows that
// exception, since nothing observes the task.
//
// WinUI-free by construction so the gate/release contract itself is
// directly testable (Maple.WinUI.Tests) without a live Window. Two real
// callers justify pulling this out rather than inlining a bool field twice
// — MainWindow.Trash.cs's delete flow (the finding) and
// MainWindow.TrashRestore.cs's restore flow (same hazard shape, same fix).

namespace Maple.WinUI.Services
{
    public sealed class SingleFlightGate
    {
        private bool _inFlight;

        /// <summary>True — and marks the gate busy — if no run is already
        /// in flight; false (and does nothing) if one is. Callers wrap
        /// their whole async flow: <c>if (!gate.TryEnter()) return; try {
        /// … } finally { gate.Exit(); }</c>.</summary>
        public bool TryEnter()
        {
            if (_inFlight) return false;
            _inFlight = true;
            return true;
        }

        public void Exit() => _inFlight = false;
    }
}

using System;

namespace Maple.UI.Atoms
{
    /// <summary>
    /// Plain, WinUI-free auto-dismiss countdown behind the Maple.UI Toast
    /// atom (docs/unified-component-catalog.md §1.5 "Toast" row:
    /// "Auto-dismiss timing"). Deliberately NOT wired to a real clock or
    /// `DispatcherTimer` itself — it is *fed* elapsed time by whatever timer
    /// the host wires up (MuiToast ticks a real WinUI `DispatcherTimer` into
    /// <see cref="Tick"/>; a test just calls Tick directly with synthetic
    /// deltas). Same split MuiRemoteImageLoader/MuiAvatarPalette use to keep
    /// the actual logic linkable into Maple.WinUI.Tests (net8.0, no WinUI)
    /// and exercisable without waiting on a real wall clock.
    ///
    /// Supports pause/resume for the common "hovering a toast keeps it up"
    /// UX — MuiToast pauses on PointerEntered, resumes on PointerExited.
    /// </summary>
    public sealed class MuiToastAutoDismissTimer
    {
        private readonly TimeSpan _duration;
        private TimeSpan _elapsed = TimeSpan.Zero;
        private bool _fired;

        public MuiToastAutoDismissTimer(TimeSpan duration)
        {
            if (duration <= TimeSpan.Zero)
                throw new ArgumentOutOfRangeException(nameof(duration));
            _duration = duration;
        }

        /// <summary>Fires exactly once, the first time accumulated elapsed
        /// time reaches the configured duration.</summary>
        public event Action? DismissRequested;

        public bool IsPaused { get; private set; }

        public TimeSpan Remaining => _fired ? TimeSpan.Zero : _duration - _elapsed;

        public void Pause() => IsPaused = true;

        public void Resume() => IsPaused = false;

        /// <summary>Restarts the countdown from zero and re-arms it to fire
        /// again — used when a toast's content is refreshed in place rather
        /// than replaced. Does not change the pause state.</summary>
        public void Reset()
        {
            _elapsed = TimeSpan.Zero;
            _fired = false;
        }

        /// <summary>Advances the countdown by <paramref name="delta"/>. A
        /// no-op while paused, already fired, or given a non-positive delta.</summary>
        public void Tick(TimeSpan delta)
        {
            if (IsPaused || _fired || delta <= TimeSpan.Zero)
                return;

            _elapsed += delta;
            if (_elapsed < _duration)
                return;

            _fired = true;
            DismissRequested?.Invoke();
        }
    }
}

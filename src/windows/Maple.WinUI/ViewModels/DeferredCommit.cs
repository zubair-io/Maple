using System;

namespace Maple.WinUI.ViewModels
{
    /// <summary>
    /// The "one model write per gesture" state machine behind a
    /// commit-on-release slider row (#3414).
    ///
    /// A decode-product field cannot be written per tick — every write
    /// re-decodes the RAW — so the row parks its value here and exactly one
    /// commit lands when the gesture ends. Three things end a gesture, and the
    /// third is why this type exists:
    ///
    /// <list type="bullet">
    /// <item>a pointer drag ends at <c>PointerCaptureLost</c>,</item>
    /// <item>an arrow-key adjustment ends at <c>KeyUp</c>,</item>
    /// <item>a mouse wheel raises NEITHER. A wheel-adjusted value would sit
    /// parked forever — no re-decode, no sidecar write, and the edit silently
    /// lost on navigate. So a wheel detent instead arms an idle flush, and a
    /// burst of detents commits once, <see cref="WheelIdleFlushMs"/> after the
    /// LAST one.</item>
    /// </list>
    ///
    /// Deliberately free of any WinUI dependency — no dispatcher, no timer, no
    /// control. Scheduling is injected, so the burst/idle behaviour is unit
    /// tested on a fake clock (<c>DeferredCommitTests</c>) rather than only
    /// through a running app.
    /// </summary>
    public sealed class DeferredCommit
    {
        /// <summary>Idle window after the last wheel detent before the burst
        /// commits, in milliseconds. Mirrors the web editor's <c>FLUSH_MS</c>
        /// (`editor-shell-wheel.ts`), so a wheel burst is one gesture with one
        /// undo entry on both platforms rather than one per detent.</summary>
        public const int WheelIdleFlushMs = 250;

        private readonly Action<double> _commit;
        private readonly Action<int, Action> _schedule;

        private double? _pending;

        /// <summary>Bumped by every event that supersedes an armed idle flush.
        /// A scheduled callback compares the generation it captured against
        /// this and does nothing if it lost the race — the cancellation
        /// mechanism, since an injected scheduler has no handle to cancel.</summary>
        private int _generation;

        /// <param name="commit">Lands the parked value as one model write.</param>
        /// <param name="schedule">Runs a callback after N milliseconds. In the
        /// app this is a timer marshalled onto the UI thread; in tests it is a
        /// fake that fires on demand.</param>
        public DeferredCommit(Action<double> commit, Action<int, Action> schedule)
        {
            _commit = commit ?? throw new ArgumentNullException(nameof(commit));
            _schedule = schedule ?? throw new ArgumentNullException(nameof(schedule));
        }

        /// <summary>True while a value is parked and not yet committed.</summary>
        public bool HasPending => _pending.HasValue;

        /// <summary>Hold a value produced by a tick of the gesture. The row's
        /// own <c>Value</c> already moved, so the chip and modified dot track
        /// the gesture live; only the model write waits.</summary>
        public void Park(double value) => _pending = value;

        /// <summary>End the gesture now and land the parked value, if any —
        /// the pointer-release / key-up path. Also supersedes any armed wheel
        /// flush, so a wheel burst followed by a pointer release commits once,
        /// not twice.</summary>
        public void Flush()
        {
            _generation++;
            if (_pending is not double value) return;
            _pending = null;
            _commit(value);
        }

        /// <summary>Record a wheel detent: supersede any flush already armed
        /// and arm a fresh one, so the burst commits once after it goes idle.</summary>
        public void WheelTick()
        {
            var generation = ++_generation;
            _schedule(WheelIdleFlushMs, () =>
            {
                // A later detent, a pointer release, or a model replacement
                // moved the generation on: that event owns the commit now.
                if (generation != _generation) return;
                Flush();
            });
        }

        /// <summary>Drop the parked value unwritten and disarm any flush — the
        /// model it would have been written onto is gone (sidecar reload,
        /// preset apply, undo).</summary>
        public void Discard()
        {
            _generation++;
            _pending = null;
        }
    }
}

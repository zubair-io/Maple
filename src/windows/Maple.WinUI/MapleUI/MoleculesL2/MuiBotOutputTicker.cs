using System;

namespace Maple.UI
{
    /// <summary>
    /// Plain, WinUI-free progressive-reveal ticker behind the Maple.UI Bot
    /// Output molecule (unified-component-catalog.md §3, "Bot Output"
    /// row). Same split as <see cref="Atoms.MuiToastAutoDismissTimer"/>:
    /// deliberately NOT wired to a real clock itself — <see cref="MuiBotOutput"/>
    /// drives it from a real WinUI <c>DispatcherTimer</c> tick; a test just
    /// calls <see cref="Tick"/> directly, deterministically, the number of
    /// times it wants.
    ///
    /// Ports `mui-bot-output.component.ts`'s <c>scheduleTick</c> exactly:
    /// each tick advances the revealed length by <c>charsPerTick</c>,
    /// clamped to the full text's length, and fires
    /// <see cref="Completed"/> exactly once, the tick that reaches it.
    /// </summary>
    public sealed class MuiBotOutputTicker
    {
        private readonly int _charsPerTick;
        private bool _completedFired;

        public MuiBotOutputTicker(int charsPerTick)
        {
            if (charsPerTick <= 0)
                throw new ArgumentOutOfRangeException(nameof(charsPerTick));
            _charsPerTick = charsPerTick;
        }

        public int VisibleLength { get; private set; }

        /// <summary>Fires exactly once, the tick <see cref="VisibleLength"/>
        /// first reaches <c>totalLength</c>.</summary>
        public event Action? Completed;

        /// <summary>Restarts the reveal from zero — used when the bound
        /// text or streaming flag changes, mirroring
        /// `ngOnChanges`'s `visibleLength.set(0)` + reschedule.</summary>
        public void Reset()
        {
            VisibleLength = 0;
            _completedFired = false;
        }

        /// <summary>Advances the reveal by one tick's worth of characters
        /// against the current full-text length. A no-op once already at
        /// (or past) <paramref name="totalLength"/>.</summary>
        public void Tick(int totalLength)
        {
            if (VisibleLength >= totalLength) return;

            VisibleLength = Math.Min(totalLength, VisibleLength + _charsPerTick);
            if (VisibleLength < totalLength || _completedFired) return;

            _completedFired = true;
            Completed?.Invoke();
        }

        /// <summary>Jumps straight to the full text, bypassing the
        /// tick-by-tick reveal — mirrors the non-streaming branch of
        /// `ngOnChanges`, which sets `visibleLength.set(this.text().length)`
        /// directly rather than scheduling ticks. Does not raise
        /// <see cref="Completed"/> (there was no reveal in progress to
        /// complete), matching the web port's own non-streaming path never
        /// touching its "did we just finish a reveal" state.</summary>
        public void RevealAll(int totalLength)
        {
            VisibleLength = totalLength;
            _completedFired = true;
        }
    }
}

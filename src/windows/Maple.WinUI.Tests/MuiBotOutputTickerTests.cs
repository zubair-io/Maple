// MuiBotOutputTickerTests — the progressive-reveal ticker behind the
// Maple.UI Bot Output molecule
// (Maple.WinUI/MapleUI/MoleculesL2/MuiBotOutputTicker.cs, wave N4 of the
// Windows Maple.UI molecules L2, #3012). Ticked directly rather than via a
// real DispatcherTimer — no WinUI/live Window, fully deterministic.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiBotOutputTickerTests
    {
        [Fact]
        public void Tick_AdvancesByCharsPerTick()
        {
            var ticker = new MuiBotOutputTicker(charsPerTick: 2);

            ticker.Tick(totalLength: 10);

            Assert.Equal(2, ticker.VisibleLength);
        }

        [Fact]
        public void Tick_ClampsToTotalLength()
        {
            var ticker = new MuiBotOutputTicker(charsPerTick: 5);

            ticker.Tick(totalLength: 3);

            Assert.Equal(3, ticker.VisibleLength);
        }

        [Fact]
        public void Tick_ReachingTotalLength_FiresCompletedExactlyOnce()
        {
            var ticker = new MuiBotOutputTicker(charsPerTick: 2);
            var completedCount = 0;
            ticker.Completed += () => completedCount++;

            ticker.Tick(totalLength: 4);
            Assert.Equal(1, completedCount);

            // Further ticks past completion must not re-fire.
            ticker.Tick(totalLength: 4);
            Assert.Equal(1, completedCount);
        }

        [Fact]
        public void Tick_BeforeReachingTotalLength_DoesNotFireCompleted()
        {
            var ticker = new MuiBotOutputTicker(charsPerTick: 2);
            var fired = false;
            ticker.Completed += () => fired = true;

            ticker.Tick(totalLength: 10);

            Assert.False(fired);
        }

        [Fact]
        public void Reset_RestartsRevealFromZero_AndReArmsCompleted()
        {
            var ticker = new MuiBotOutputTicker(charsPerTick: 4);
            var completedCount = 0;
            ticker.Completed += () => completedCount++;

            ticker.Tick(totalLength: 4);
            Assert.Equal(1, completedCount);

            ticker.Reset();
            Assert.Equal(0, ticker.VisibleLength);

            ticker.Tick(totalLength: 4);
            Assert.Equal(2, completedCount);
        }

        [Fact]
        public void RevealAll_JumpsStraightToFullLength()
        {
            var ticker = new MuiBotOutputTicker(charsPerTick: 2);

            ticker.RevealAll(totalLength: 40);

            Assert.Equal(40, ticker.VisibleLength);
        }

        [Fact]
        public void RevealAll_DoesNotFireCompleted()
        {
            // Mirrors the non-streaming branch of ngOnChanges, which never
            // touches "did a reveal just finish" state.
            var ticker = new MuiBotOutputTicker(charsPerTick: 2);
            var fired = false;
            ticker.Completed += () => fired = true;

            ticker.RevealAll(totalLength: 40);

            Assert.False(fired);
        }

        [Fact]
        public void RevealAll_ThenTick_IsANoOp()
        {
            var ticker = new MuiBotOutputTicker(charsPerTick: 2);
            ticker.RevealAll(totalLength: 10);

            ticker.Tick(totalLength: 10);

            Assert.Equal(10, ticker.VisibleLength);
        }
    }
}

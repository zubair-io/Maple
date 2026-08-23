// MuiToastAutoDismissTimerTests — the injectable-tick auto-dismiss countdown
// behind the Maple.UI Toast atom (Maple.WinUI/MapleUI/Atoms/
// MuiToastAutoDismissTimer.cs, wave 2 of the Windows Maple.UI atoms, #3012).
// Fed synthetic TimeSpan deltas directly via Tick() rather than a real
// DispatcherTimer or wall-clock wait — no WinUI/live Window, no flaky
// Thread.Sleep timing, fully deterministic.

using System;
using Maple.UI.Atoms;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiToastAutoDismissTimerTests
    {
        [Fact]
        public void Tick_BeforeDurationElapses_DoesNotFire()
        {
            var timer = new MuiToastAutoDismissTimer(TimeSpan.FromSeconds(5));
            var fired = false;
            timer.DismissRequested += () => fired = true;

            timer.Tick(TimeSpan.FromSeconds(3));

            Assert.False(fired);
        }

        [Fact]
        public void Tick_ReachingExactlyTheDuration_Fires()
        {
            var timer = new MuiToastAutoDismissTimer(TimeSpan.FromSeconds(5));
            var fired = false;
            timer.DismissRequested += () => fired = true;

            timer.Tick(TimeSpan.FromSeconds(2));
            timer.Tick(TimeSpan.FromSeconds(3));

            Assert.True(fired);
        }

        [Fact]
        public void Tick_PastTheDuration_FiresOnlyOnce()
        {
            var timer = new MuiToastAutoDismissTimer(TimeSpan.FromSeconds(5));
            var fireCount = 0;
            timer.DismissRequested += () => fireCount++;

            timer.Tick(TimeSpan.FromSeconds(3));
            timer.Tick(TimeSpan.FromSeconds(3));
            timer.Tick(TimeSpan.FromSeconds(3));

            Assert.Equal(1, fireCount);
        }

        [Fact]
        public void Pause_StopsAccumulatingElapsedTime()
        {
            var timer = new MuiToastAutoDismissTimer(TimeSpan.FromSeconds(5));
            var fired = false;
            timer.DismissRequested += () => fired = true;

            timer.Tick(TimeSpan.FromSeconds(3));
            timer.Pause();
            timer.Tick(TimeSpan.FromSeconds(10)); // must be dropped entirely while paused

            Assert.False(fired);
            Assert.True(timer.IsPaused);
        }

        [Fact]
        public void Resume_ContinuesFromWhereItWasPaused_NotFromZero()
        {
            var timer = new MuiToastAutoDismissTimer(TimeSpan.FromSeconds(5));
            var fired = false;
            timer.DismissRequested += () => fired = true;

            timer.Tick(TimeSpan.FromSeconds(4));
            timer.Pause();
            timer.Tick(TimeSpan.FromSeconds(100)); // dropped
            timer.Resume();
            Assert.False(fired);

            timer.Tick(TimeSpan.FromSeconds(1)); // 4 + 1 = 5, the full duration
            Assert.True(fired);
        }

        [Fact]
        public void Reset_RestartsTheCountdownAndReArmsFiring()
        {
            var timer = new MuiToastAutoDismissTimer(TimeSpan.FromSeconds(5));
            var fireCount = 0;
            timer.DismissRequested += () => fireCount++;

            timer.Tick(TimeSpan.FromSeconds(5));
            Assert.Equal(1, fireCount);

            timer.Reset();
            timer.Tick(TimeSpan.FromSeconds(3));
            Assert.Equal(1, fireCount); // not yet re-fired

            timer.Tick(TimeSpan.FromSeconds(2));
            Assert.Equal(2, fireCount);
        }

        [Fact]
        public void Remaining_ReflectsElapsedTime_AndIsZeroAfterFiring()
        {
            var timer = new MuiToastAutoDismissTimer(TimeSpan.FromSeconds(5));

            timer.Tick(TimeSpan.FromSeconds(2));
            Assert.Equal(TimeSpan.FromSeconds(3), timer.Remaining);

            timer.Tick(TimeSpan.FromSeconds(10));
            Assert.Equal(TimeSpan.Zero, timer.Remaining);
        }

        [Fact]
        public void Constructor_NonPositiveDuration_Throws()
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => new MuiToastAutoDismissTimer(TimeSpan.Zero));
            Assert.Throws<ArgumentOutOfRangeException>(() => new MuiToastAutoDismissTimer(TimeSpan.FromSeconds(-1)));
        }

        [Fact]
        public void Tick_WithNonPositiveDelta_IsANoOp()
        {
            var timer = new MuiToastAutoDismissTimer(TimeSpan.FromSeconds(5));
            timer.Tick(TimeSpan.Zero);
            timer.Tick(TimeSpan.FromSeconds(-1));
            Assert.Equal(TimeSpan.FromSeconds(5), timer.Remaining);
        }
    }
}

using System.Linq;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    /// <summary>
    /// The one-write-per-gesture contract behind a commit-on-release slider row
    /// (#3414). These run WinUI-free on a fake clock: `DeferredCommit` takes its
    /// scheduler as a delegate precisely so the wheel-burst timing is provable
    /// here rather than only by hand in a running app.
    /// </summary>
    public class DeferredCommitTests
    {
        /// <summary>A virtual clock. Scheduling records a DEADLINE rather than
        /// just a callback, so a test can advance time in steps and see which
        /// timer would really have fired first.
        ///
        /// That distinction is the whole point: a fake that fires every armed
        /// callback in one sweep cannot tell "committed after the burst went
        /// idle" from "committed early, on a timer armed mid-burst" — both look
        /// like one commit. Modelling deadlines is what makes
        /// <see cref="AnEarlyTimerFromMidBurstDoesNotCommit"/> able to fail.</summary>
        private sealed class FakeClock
        {
            private readonly List<(int DueAtMs, Action Callback)> _armed = new();

            public int NowMs { get; private set; }

            public IReadOnlyList<(int DueAtMs, Action Callback)> Armed => _armed;

            public void Schedule(int delayMs, Action callback) =>
                _armed.Add((NowMs + delayMs, callback));

            /// <summary>Move the clock forward, firing every timer whose
            /// deadline the new time has reached, earliest first.</summary>
            public void AdvanceBy(int deltaMs)
            {
                NowMs += deltaMs;
                foreach (var (_, callback) in _armed.Where(a => a.DueAtMs <= NowMs)
                             .OrderBy(a => a.DueAtMs).ToList())
                    callback();
            }

            /// <summary>Advance well past every armed deadline.</summary>
            public void AdvancePastIdle() => AdvanceBy(DeferredCommit.WheelIdleFlushMs + 1);
        }

        private static (DeferredCommit Gate, List<double> Commits, FakeClock Clock) Build()
        {
            var commits = new List<double>();
            var clock = new FakeClock();
            var gate = new DeferredCommit(commits.Add, clock.Schedule);
            return (gate, commits, clock);
        }

        [Fact]
        public void PointerReleaseCommitsTheParkedValueOnce()
        {
            var (gate, commits, _) = Build();
            gate.Park(10);
            gate.Park(20);
            gate.Park(30);
            Assert.True(gate.HasPending);
            Assert.Empty(commits);

            gate.Flush();
            Assert.Equal(new[] { 30.0 }, commits);
            Assert.False(gate.HasPending);

            // A second release with nothing parked must not re-commit.
            gate.Flush();
            Assert.Equal(new[] { 30.0 }, commits);
        }

        /// <summary>THE REGRESSION: a wheel raises neither PointerCaptureLost
        /// nor KeyUp, so before #3414's fix a wheel-adjusted value stayed parked
        /// forever — no re-decode, no sidecar write, edit lost on navigate.</summary>
        [Fact]
        public void WheelThenIdleCommitsExactlyOnce()
        {
            var (gate, commits, clock) = Build();

            // A burst: five detents 100ms apart — closer together than the
            // idle window, so the burst never goes idle mid-scroll.
            foreach (var value in new[] { 1.0, 2.0, 3.0, 4.0, 5.0 })
            {
                gate.Park(value);
                gate.WheelTick();
                clock.AdvanceBy(100);
            }
            // Nothing lands while the wheel is still turning, even though four
            // of the five armed deadlines have now passed.
            Assert.Empty(commits);
            Assert.Equal(5, clock.Armed.Count);

            clock.AdvancePastIdle();

            // One commit for the whole burst, carrying the LAST value — one
            // gesture, one undo entry, matching the web editor's FLUSH_MS
            // contract rather than committing per detent.
            Assert.Equal(new[] { 5.0 }, commits);
            Assert.False(gate.HasPending);
        }

        [Fact]
        public void WheelIdleWindowMatchesTheWebFlushContract()
        {
            var (gate, _, clock) = Build();
            gate.Park(1);
            gate.WheelTick();
            Assert.Equal(DeferredCommit.WheelIdleFlushMs, clock.Armed[0].DueAtMs - clock.NowMs);
            Assert.Equal(250, DeferredCommit.WheelIdleFlushMs);
        }

        /// <summary>A wheel over the thumb, then a drag: the armed idle flush
        /// must not fire a second write after the release already committed.</summary>
        [Fact]
        public void WheelThenPointerReleaseDoesNotDoubleCommit()
        {
            var (gate, commits, clock) = Build();
            gate.Park(40);
            gate.WheelTick();

            // The release beats the idle window.
            gate.Flush();
            Assert.Equal(new[] { 40.0 }, commits);

            // The superseded timer still comes due; it must be a no-op.
            clock.AdvancePastIdle();
            Assert.Equal(new[] { 40.0 }, commits);
        }

        /// <summary>The generation guard's real job. Mid-burst, a timer armed
        /// by an EARLIER detent comes due while the user is still scrolling. If
        /// it were allowed to run, the burst would commit 250ms after its FIRST
        /// detent instead of its last — splitting one slow wheel gesture into
        /// several re-decodes and several undo entries.
        ///
        /// Deleting the `generation != _generation` check in `DeferredCommit`
        /// makes this test fail (verified by mutation); the sibling
        /// double-commit test does not, because `Flush` nulls `_pending`
        /// anyway.</summary>
        [Fact]
        public void AnEarlyTimerFromMidBurstDoesNotCommit()
        {
            var (gate, commits, clock) = Build();

            gate.Park(1);
            gate.WheelTick();          // armed for t=250

            clock.AdvanceBy(200);      // t=200, still scrolling
            gate.Park(2);
            gate.WheelTick();          // armed for t=450

            // t=300: the FIRST detent's timer is now due. It must not fire the
            // commit — the burst has not gone idle.
            clock.AdvanceBy(100);
            Assert.Empty(commits);
            Assert.True(gate.HasPending);

            // t=500: the last detent's window has elapsed. One commit, last value.
            clock.AdvanceBy(200);
            Assert.Equal(new[] { 2.0 }, commits);
        }

        [Fact]
        public void ASecondBurstAfterAFlushCommitsAgain()
        {
            var (gate, commits, clock) = Build();
            gate.Park(10);
            gate.WheelTick();
            clock.AdvancePastIdle();
            Assert.Equal(new[] { 10.0 }, commits);

            // The row is still live: a later burst is its own gesture.
            gate.Park(60);
            gate.WheelTick();
            clock.AdvancePastIdle();
            Assert.Equal(new[] { 10.0, 60.0 }, commits);
        }

        /// <summary>A model replacement (undo, preset apply, sidecar reload)
        /// drops the parked value: the state it would have been written onto is
        /// gone, and an armed wheel flush must not resurrect it.</summary>
        [Fact]
        public void DiscardDropsThePendingValueAndDisarmsTheWheelFlush()
        {
            var (gate, commits, clock) = Build();
            gate.Park(70);
            gate.WheelTick();

            gate.Discard();
            Assert.False(gate.HasPending);

            clock.AdvancePastIdle();
            Assert.Empty(commits);

            // And a release afterwards has nothing to write either.
            gate.Flush();
            Assert.Empty(commits);
        }

        /// <summary>A wheel over a row already at its range end moves nothing,
        /// so no value is parked and the armed flush must stay silent.</summary>
        [Fact]
        public void AWheelThatChangesNothingCommitsNothing()
        {
            var (gate, commits, clock) = Build();
            gate.WheelTick();
            clock.AdvancePastIdle();
            Assert.Empty(commits);
        }
    }
}

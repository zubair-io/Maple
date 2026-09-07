// MuiSyncGateTests — pins the re-entrancy contract MuiMaskPanel relies on
// to stop a programmatic model->UI sync from round-tripping back out as a
// user-originated event (#3435 review).

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiSyncGateTests
    {
        [Fact]
        public void NotSyncingByDefault() => Assert.False(new MuiSyncGate().IsSyncing);

        [Fact]
        public void IsSyncingWhileRunSyncedIsExecuting()
        {
            var gate = new MuiSyncGate();
            var observedDuring = false;
            gate.RunSynced(() => observedDuring = gate.IsSyncing);
            Assert.True(observedDuring);
        }

        [Fact]
        public void IsNotSyncingAfterRunSyncedReturns()
        {
            var gate = new MuiSyncGate();
            gate.RunSynced(() => { });
            Assert.False(gate.IsSyncing);
        }

        [Fact]
        public void StaysSyncingThroughoutANestedRunSynced()
        {
            // Mirrors MuiMaskPanel: the Adjustments DP callback's sync can
            // run while the Feather/Invert DP callbacks' own syncs are also
            // in flight (three separate DP assignments in one
            // UpdateMaskDisplay() call) — the gate must report "syncing"
            // until the OUTERMOST RunSynced unwinds, not the innermost.
            var gate = new MuiSyncGate();
            var observedAfterInnerReturns = false;
            gate.RunSynced(() =>
            {
                gate.RunSynced(() => { });
                observedAfterInnerReturns = gate.IsSyncing;
            });
            Assert.True(observedAfterInnerReturns);
            Assert.False(gate.IsSyncing);
        }

        [Fact]
        public void DepthIsRestoredEvenWhenApplyThrows()
        {
            var gate = new MuiSyncGate();
            Assert.Throws<System.InvalidOperationException>(() =>
                gate.RunSynced(() => throw new System.InvalidOperationException("boom")));
            Assert.False(gate.IsSyncing);
        }
    }
}

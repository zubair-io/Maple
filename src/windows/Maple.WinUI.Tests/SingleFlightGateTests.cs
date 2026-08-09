// SingleFlightGateTests — the pure gate/release contract behind the
// #2743-review reentrancy fix (MainWindow.Trash.cs's _deleteGate,
// MainWindow.TrashRestore.cs's _restoreGate). No WinUI/live Window involved
// — this is exactly the WinUI-free slice the review asked to cover.

using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class SingleFlightGateTests
    {
        [Fact]
        public void TryEnter_WhenIdle_ReturnsTrue()
        {
            var gate = new SingleFlightGate();
            Assert.True(gate.TryEnter());
        }

        [Fact]
        public void TryEnter_WhileAlreadyInFlight_ReturnsFalse()
        {
            var gate = new SingleFlightGate();
            Assert.True(gate.TryEnter());

            Assert.False(gate.TryEnter());
        }

        [Fact]
        public void TryEnter_AfterExit_ReturnsTrueAgain()
        {
            var gate = new SingleFlightGate();
            Assert.True(gate.TryEnter());
            gate.Exit();

            Assert.True(gate.TryEnter());
        }

        [Fact]
        public void Exit_WithoutAPriorTryEnter_IsANoOp()
        {
            var gate = new SingleFlightGate();

            gate.Exit(); // must not throw

            Assert.True(gate.TryEnter());
        }

        [Fact]
        public void RepeatedTryEnterCalls_WhileInFlight_AllReturnFalse()
        {
            // Models key-repeat on a held Delete key: several re-entrant
            // calls land before the first run's `finally { gate.Exit(); }`
            // — every one of them must be dropped, not just the second.
            var gate = new SingleFlightGate();
            Assert.True(gate.TryEnter());

            Assert.False(gate.TryEnter());
            Assert.False(gate.TryEnter());
            Assert.False(gate.TryEnter());
        }
    }
}

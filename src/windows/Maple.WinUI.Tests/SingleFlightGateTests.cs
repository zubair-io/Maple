// SingleFlightGateTests — the pure gate/release contract behind the
// #2743-review reentrancy fix (MainWindow.Trash.cs's _deleteGate,
// MainWindow.TrashRestore.cs's _restoreGate) and the #2948 fix that gave
// RunDragMoveAsync (reachable from both MainWindow.DragDrop.cs's
// OnFolderDrop and MainWindow.MoveToFolder.cs's OnMoveToFolder),
// OnBatchRename, and OnStitchPano a SHARED gate instance
// (MainWindow.DragDrop.cs's `_modalFlowGate`) rather than one each — see
// that field's doc comment for why sharing is correct there. No WinUI/live
// Window involved — this is exactly the WinUI-free slice both reviews asked
// to cover.

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

        [Fact]
        public void SharedGateAcrossDistinctFlows_BlocksEachOtherWhileOneIsInFlight()
        {
            // Models #2948's _modalFlowGate: one SingleFlightGate instance
            // guarding several independent entry points (drag-drop, Move to
            // Folder, Batch Rename, Stitch Panorama) rather than one gate
            // per flow, because a ContentDialog from any one of them blocks
            // a ContentDialog from any other — a drag-drop landing while
            // Batch Rename's dialog is still open is just as much a
            // second-ShowAsync crash as re-entering Batch Rename itself.
            var modalFlowGate = new SingleFlightGate();

            // "OnBatchRename" enters first...
            Assert.True(modalFlowGate.TryEnter());

            // ...so a drag-drop, a Move to Folder, and a Stitch Panorama
            // that all land before it exits must every one be dropped, not
            // just re-entrant calls to Batch Rename itself.
            Assert.False(modalFlowGate.TryEnter()); // would-be OnFolderDrop
            Assert.False(modalFlowGate.TryEnter()); // would-be OnMoveToFolder
            Assert.False(modalFlowGate.TryEnter()); // would-be OnStitchPano

            modalFlowGate.Exit(); // Batch Rename's flow completes

            // Once free, any of the other flows can now claim it.
            Assert.True(modalFlowGate.TryEnter()); // would-be OnFolderDrop
        }
    }
}

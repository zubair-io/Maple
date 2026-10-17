// UndoHistoryLogicTests — the stack rules Reset and Revert must obey (#4764).
// Before: both pushed the mid-edit state straight onto the undo stack with
// no boundary commit, no no-op check and no depth cap, so a drag still in
// its quiet window never entered history (Undo landed mid-drag and the
// pre-drag state was unreachable) and Ctrl+R on an unedited photo stacked
// duplicates while wiping Redo.

using System.Collections.Generic;
using Maple.WinUI.Models;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests;

public class UndoHistoryLogicTests
{
    private const int Depth = 50;
    private readonly List<AdjustmentState> _undo = new();
    private readonly List<AdjustmentState> _redo = new();

    private static AdjustmentState WithExposure(double ev)
    {
        var s = new AdjustmentState();
        s.Exposure = ev;
        return s;
    }

    [Fact]
    public void RevertDuringAQuietWindow_RecordsThePreDragStateFirst()
    {
        // Open at +1 EV, drag to +2 EV, Ctrl+R inside the 450 ms window.
        var original = WithExposure(1.0);
        AdjustmentState? baseline = original.Clone();
        var midDrag = WithExposure(2.0);

        var replaced = UndoHistoryLogic.ReplaceModel(_undo, _redo, ref baseline, midDrag, original, Depth);

        Assert.True(replaced);
        Assert.Equal(2, _undo.Count);
        Assert.Equal(1.0, _undo[0].Exposure);   // pre-drag: reachable by a second Undo
        Assert.Equal(2.0, _undo[1].Exposure);   // mid-drag: what the first Undo returns to
        Assert.True(UndoHistoryLogic.SameEdit(baseline, original));
    }

    [Fact]
    public void ReplacementThatChangesNothing_RecordsNothingAndKeepsRedo()
    {
        var current = new AdjustmentState();
        AdjustmentState? baseline = current.Clone();
        _redo.Add(WithExposure(0.5));

        var replaced = UndoHistoryLogic.ReplaceModel(_undo, _redo, ref baseline, current, new AdjustmentState(), Depth);

        Assert.False(replaced);
        Assert.Empty(_undo);
        Assert.Single(_redo);
    }

    [Fact]
    public void RepeatedReplacement_DoesNotStackDuplicates()
    {
        var current = WithExposure(1.0);
        AdjustmentState? baseline = current.Clone();
        var defaults = new AdjustmentState();

        Assert.True(UndoHistoryLogic.ReplaceModel(_undo, _redo, ref baseline, current, defaults, Depth));
        Assert.False(UndoHistoryLogic.ReplaceModel(_undo, _redo, ref baseline, defaults, defaults, Depth));
        Assert.False(UndoHistoryLogic.ReplaceModel(_undo, _redo, ref baseline, defaults, defaults, Depth));

        Assert.Single(_undo);
    }

    [Fact]
    public void Push_CapsDepthFromTheOldestEnd_AndInvalidatesRedo()
    {
        _redo.Add(WithExposure(9));
        for (var i = 0; i < Depth + 3; i++)
            UndoHistoryLogic.Push(_undo, _redo, WithExposure(i), Depth);

        Assert.Equal(Depth, _undo.Count);
        Assert.Equal(3, _undo[0].Exposure);
        Assert.Equal(Depth + 2, _undo[^1].Exposure);
        Assert.Empty(_redo);
    }

    [Fact]
    public void CommitBoundary_IsANoOpWithoutAPendingEdit()
    {
        var current = WithExposure(1.0);
        AdjustmentState? baseline = current.Clone();

        Assert.False(UndoHistoryLogic.CommitBoundary(_undo, _redo, ref baseline, current, Depth));
        AdjustmentState? none = null;
        Assert.False(UndoHistoryLogic.CommitBoundary(_undo, _redo, ref none, current, Depth));
        Assert.Empty(_undo);
    }
}

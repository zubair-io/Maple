// SavedPreviewDeferralTests — the WinUI-free rule behind #4374: while the
// shell is in Edit the editor's own decode owns the machine, so a saved
// preview is never started there; it is cancelled on entry, remembered, and
// run when the shell returns to Preview or Browse. Photos are plain strings,
// the same stand-in ViewerFilmstripLogicTests uses.

using Maple.WinUI;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class SavedPreviewDeferralTests
    {
        private static readonly string[] Nothing = Array.Empty<string>();

        private static SavedPreviewDeferral<string> Editing(params string[] inFlight) =>
            SavedPreviewDeferral<string>.Idle.Enter(ShellMode.Edit, inFlight).Next;

        [Theory]
        [InlineData(ShellMode.Browse)]
        [InlineData(ShellMode.Preview)]
        public void Request_OutsideEdit_StartsAndOwesNothing(ShellMode mode)
        {
            var state = SavedPreviewDeferral<string>.Idle.Enter(mode, Nothing).Next;

            var (next, start) = state.Request("a");

            Assert.True(start);
            Assert.False(next.Editing);
            Assert.Empty(next.Owed);
        }

        [Fact]
        public void Request_InEdit_IsDeferredAndOwed()
        {
            var (next, start) = Editing().Request("a");

            Assert.False(start);
            Assert.Equal(new[] { "a" }, next.Owed);
        }

        [Fact]
        public void Request_InEdit_RepeatedSaves_OweThePhotoOnce()
        {
            var state = Editing().Request("a").Next.Edited("a").Request("a").Next;

            Assert.Equal(new[] { "a" }, state.Owed);
        }

        [Fact]
        public void Request_InEdit_AfterAnAcknowledgedAutosave_IsOwedUntilEditIsLeft()
        {
            var (inEdit, start) = Editing("a").Request("cloud");
            var left = inEdit.Enter(ShellMode.Preview, Nothing);

            Assert.False(start);
            Assert.Equal(new[] { "a", "cloud" }, left.Release);
            Assert.True(left.Next.Request("cloud").Start);
        }

        [Fact]
        public void Edited_InEdit_OwesThePhotoBeforeItsSaveLands()
        {
            Assert.Equal(new[] { "a" }, Editing().Edited("a").Owed);
        }

        [Fact]
        public void Edited_OutsideEdit_OwesNothing()
        {
            Assert.Empty(SavedPreviewDeferral<string>.Idle.Edited("a").Owed);
        }

        [Fact]
        public void EnterEdit_WithRunningRefreshes_CancelsThemAndOwesTheirPhotos()
        {
            var change = SavedPreviewDeferral<string>.Idle.Enter(ShellMode.Edit, new[] { "a", "b", "a" });

            Assert.True(change.Cancel);
            Assert.True(change.Next.Editing);
            Assert.Equal(new[] { "a", "b" }, change.Next.Owed);
            Assert.Empty(change.Release);
        }

        [Fact]
        public void EnterEdit_WhenIdle_CancelsNothing()
        {
            var change = SavedPreviewDeferral<string>.Idle.Enter(ShellMode.Edit, Nothing);

            Assert.False(change.Cancel);
            Assert.True(change.Next.Editing);
            Assert.Empty(change.Next.Owed);
        }

        [Theory]
        [InlineData(ShellMode.Browse)]
        [InlineData(ShellMode.Preview)]
        public void LeaveEdit_ReleasesEveryOwedPhotoInTheOrderOwed(ShellMode mode)
        {
            var state = Editing("a").Request("b").Next.Edited("c");

            var change = state.Enter(mode, Nothing);

            Assert.Equal(new[] { "a", "b", "c" }, change.Release);
            Assert.False(change.Cancel);
            Assert.False(change.Next.Editing);
            Assert.Empty(change.Next.Owed);
        }

        [Fact]
        public void LeaveEdit_WithNothingOwed_ReleasesNothing()
        {
            Assert.Empty(Editing().Enter(ShellMode.Preview, Nothing).Release);
        }

        [Fact]
        public void StayingInEdit_KeepsTheDebtAndCancelsNothing()
        {
            var state = Editing().Request("a").Next;

            var change = state.Enter(ShellMode.Edit, Nothing);

            Assert.Same(state, change.Next);
            Assert.False(change.Cancel);
            Assert.Empty(change.Release);
        }

        [Fact]
        public void MovingBetweenBrowseAndPreview_NeverCancelsARunningRequest()
        {
            var change = SavedPreviewDeferral<string>.Idle.Enter(ShellMode.Preview, new[] { "a" });

            Assert.False(change.Cancel);
            Assert.Empty(change.Release);
            Assert.Empty(change.Next.Owed);
        }

        [Fact]
        public void SelectionChangeInEdit_KeepsTheEarlierPhotoOwed()
        {
            var state = Editing().Edited("a").Request("b").Next;

            Assert.Equal(new[] { "a", "b" }, state.Enter(ShellMode.Browse, Nothing).Release);
        }

        [Fact]
        public void ReleasedDebt_IsNotReleasedAgainOnTheNextEditSession()
        {
            var left = Editing().Request("a").Next.Enter(ShellMode.Preview, Nothing).Next;

            var again = left.Enter(ShellMode.Edit, Nothing).Next.Enter(ShellMode.Preview, Nothing);

            Assert.Empty(again.Release);
        }
    }
}

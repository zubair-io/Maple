using Maple.WinUI;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class SavedPreviewDeferralTests
    {
        private static readonly PhotoItem A = new() { FileName = "a" };
        private static readonly PhotoItem B = new() { FileName = "b" };
        private static readonly PhotoItem C = new() { FileName = "c" };
        private static readonly PhotoItem Cloud = new() { FileName = "cloud" };
        private static readonly PhotoItem[] Nothing = Array.Empty<PhotoItem>();

        private static SavedPreviewDeferral Editing(params PhotoItem[] inFlight) =>
            SavedPreviewDeferral.Idle.Enter(ShellMode.Edit, inFlight).Next;

        [Theory]
        [InlineData(ShellMode.Browse)]
        [InlineData(ShellMode.Preview)]
        public void Request_OutsideEdit_StartsAndOwesNothing(ShellMode mode)
        {
            var state = SavedPreviewDeferral.Idle.Enter(mode, Nothing).Next;

            var (next, start) = state.Request(A);

            Assert.True(start);
            Assert.False(next.Editing);
            Assert.Empty(next.Owed);
        }

        [Fact]
        public void Request_InEdit_IsDeferredAndOwed()
        {
            var (next, start) = Editing().Request(A);

            Assert.False(start);
            Assert.Equal(new[] { A }, next.Owed);
        }

        [Fact]
        public void Request_InEdit_RepeatedSaves_OweThePhotoOnce()
        {
            var state = Editing().Request(A).Next.Edited(A).Request(A).Next;

            Assert.Equal(new[] { A }, state.Owed);
        }

        [Fact]
        public void Request_InEdit_AfterAnAcknowledgedAutosave_IsOwedUntilEditIsLeft()
        {
            var (inEdit, start) = Editing(A).Request(Cloud);
            var left = inEdit.Enter(ShellMode.Preview, Nothing);

            Assert.False(start);
            Assert.Equal(new[] { A, Cloud }, left.Release);
            Assert.True(left.Next.Request(Cloud).Start);
        }

        [Fact]
        public void Edited_InEdit_OwesThePhotoBeforeItsSaveLands()
        {
            Assert.Equal(new[] { A }, Editing().Edited(A).Owed);
        }

        [Fact]
        public void Edited_OutsideEdit_OwesNothing()
        {
            Assert.Empty(SavedPreviewDeferral.Idle.Edited(A).Owed);
        }

        [Fact]
        public void EnterEdit_WithRunningRefreshes_CancelsThemAndOwesTheirPhotos()
        {
            var change = SavedPreviewDeferral.Idle.Enter(ShellMode.Edit, new[] { A, B, A });

            Assert.True(change.Cancel);
            Assert.True(change.Next.Editing);
            Assert.Equal(new[] { A, B }, change.Next.Owed);
            Assert.Empty(change.Release);
        }

        [Fact]
        public void EnterEdit_WhenIdle_CancelsNothing()
        {
            var change = SavedPreviewDeferral.Idle.Enter(ShellMode.Edit, Nothing);

            Assert.False(change.Cancel);
            Assert.True(change.Next.Editing);
            Assert.Empty(change.Next.Owed);
        }

        [Theory]
        [InlineData(ShellMode.Browse)]
        [InlineData(ShellMode.Preview)]
        public void LeaveEdit_ReleasesEveryOwedPhotoInTheOrderOwed(ShellMode mode)
        {
            var state = Editing(A).Request(B).Next.Edited(C);

            var change = state.Enter(mode, Nothing);

            Assert.Equal(new[] { A, B, C }, change.Release);
            Assert.False(change.Cancel);
            Assert.False(change.Next.Editing);
            Assert.Equal(new[] { A, B, C }, change.Next.Owed);
        }

        [Fact]
        public void LeaveEdit_WithNothingOwed_ReleasesNothing()
        {
            Assert.Empty(Editing().Enter(ShellMode.Preview, Nothing).Release);
        }

        [Fact]
        public void StayingInEdit_KeepsTheDebtAndCancelsNothing()
        {
            var state = Editing().Request(A).Next;

            var change = state.Enter(ShellMode.Edit, Nothing);

            Assert.Same(state, change.Next);
            Assert.False(change.Cancel);
            Assert.Empty(change.Release);
        }

        [Fact]
        public void MovingBetweenBrowseAndPreview_NeverCancelsARunningRequest()
        {
            var change = SavedPreviewDeferral.Idle.Enter(ShellMode.Preview, new[] { A });

            Assert.False(change.Cancel);
            Assert.Empty(change.Release);
            Assert.Empty(change.Next.Owed);
        }

        [Fact]
        public void SelectionChangeInEdit_KeepsTheEarlierPhotoOwed()
        {
            var state = Editing().Edited(A).Request(B).Next;

            Assert.Equal(new[] { A, B }, state.Enter(ShellMode.Browse, Nothing).Release);
        }

        [Fact]
        public void Settle_AFailedRefreshStaysOwedAndIsRetriedOnTheNextLeaveOfEdit()
        {
            var state = SavedPreviewDeferral.Idle.Settle(A, SavedPreviewRefreshOutcome.Failed);

            var retry = state.Enter(ShellMode.Edit, Nothing).Next.Enter(ShellMode.Preview, Nothing);

            Assert.Equal(new[] { A }, state.Owed);
            Assert.Equal(new[] { A }, retry.Release);
        }

        [Fact]
        public void Settle_ACancelledRefreshStaysOwed()
        {
            var state = SavedPreviewDeferral.Idle.Settle(A, SavedPreviewRefreshOutcome.Cancelled);

            Assert.Equal(new[] { A }, state.Owed);
        }

        [Fact]
        public void Settle_ARefreshedPhotoIsClearedAndOthersStayOwed()
        {
            var state = SavedPreviewDeferral.Idle
                .Settle(A, SavedPreviewRefreshOutcome.Failed)
                .Settle(B, SavedPreviewRefreshOutcome.Failed)
                .Settle(A, SavedPreviewRefreshOutcome.Refreshed);

            Assert.Equal(new[] { B }, state.Owed);
        }

        [Fact]
        public void Settle_FailureIsOwedOnceHoweverOftenItRepeats()
        {
            var state = SavedPreviewDeferral.Idle
                .Settle(A, SavedPreviewRefreshOutcome.Failed)
                .Settle(A, SavedPreviewRefreshOutcome.Failed);

            Assert.Equal(new[] { A }, state.Owed);
        }

        [Fact]
        public void EnterEdit_KeepsPhotosStillOwedFromAnEarlierFailure()
        {
            var failed = SavedPreviewDeferral.Idle.Settle(A, SavedPreviewRefreshOutcome.Failed);

            var change = failed.Enter(ShellMode.Edit, new[] { B });

            Assert.Equal(new[] { A, B }, change.Next.Owed);
        }

        [Fact]
        public void ReleasedDebt_StaysOwedUntilARefreshIsConfirmed()
        {
            var left = Editing().Request(A).Next.Enter(ShellMode.Preview, Nothing).Next;

            var cancelled = left.Settle(A, SavedPreviewRefreshOutcome.Cancelled);
            var refreshed = cancelled.Settle(A, SavedPreviewRefreshOutcome.Refreshed);

            Assert.Equal(new[] { A }, left.Owed);
            Assert.Equal(new[] { A }, cancelled.Owed);
            Assert.Empty(refreshed.Owed);
        }

        [Fact]
        public void ReleasedDebt_ThatWasNeverConfirmed_IsReleasedAgainAndNotDuplicated()
        {
            var left = Editing().Request(A).Next.Enter(ShellMode.Preview, Nothing).Next;

            var backInEdit = left.Enter(ShellMode.Edit, new[] { A }).Next;
            var again = backInEdit.Enter(ShellMode.Preview, Nothing);

            Assert.Equal(new[] { A }, backInEdit.Owed);
            Assert.Equal(new[] { A }, again.Release);
        }

        [Fact]
        public void SettledDebt_IsNotReleasedAgainOnTheNextEditSession()
        {
            var left = Editing().Request(A).Next.Enter(ShellMode.Preview, Nothing).Next
                .Settle(A, SavedPreviewRefreshOutcome.Refreshed);

            var again = left.Enter(ShellMode.Edit, Nothing).Next.Enter(ShellMode.Preview, Nothing);

            Assert.Empty(again.Release);
        }

        [Theory]
        [InlineData(true, false, false, SavedPreviewReleaseAction.RefreshThumbnail)]
        [InlineData(true, true, true, SavedPreviewReleaseAction.RefreshThumbnail)]
        [InlineData(true, true, false, SavedPreviewReleaseAction.Drop)]
        [InlineData(false, false, false, SavedPreviewReleaseAction.Drop)]
        [InlineData(false, true, true, SavedPreviewReleaseAction.Drop)]
        public void ClassifyUnselected_RefreshesOnlyWhatCanBeRefreshed(
            bool listed, bool cloud, bool cloudRefreshable, SavedPreviewReleaseAction expected)
        {
            Assert.Equal(expected, SavedPreviewDeferral.ClassifyUnselected(listed, cloud, cloudRefreshable));
        }

        [Fact]
        public void MaySettle_OlderRenderWithNewerAcknowledgement_KeepsTheDebt()
        {
            Assert.False(SavedPreviewDeferral.MaySettle(new object(), new object()));
            Assert.False(SavedPreviewDeferral.MaySettle(null, new object()));
        }

        [Fact]
        public void MaySettle_MatchingRender_Settles()
        {
            var save = new object();

            Assert.True(SavedPreviewDeferral.MaySettle(save, save));
        }

        [Fact]
        public void MaySettle_NoAcknowledgedSnapshot_SettlesAsBefore()
        {
            Assert.True(SavedPreviewDeferral.MaySettle(null, null));
            Assert.True(SavedPreviewDeferral.MaySettle(new object(), null));
        }
    }
}

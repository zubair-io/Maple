// LibraryChangeQueueTests — the pure debounce bookkeeping behind
// LibraryWatcher.cs's live grid updates and #2657's rename tracking. No
// FileSystemWatcher, no Timer, no filesystem: these drive the
// add/remove/rename state machine directly the way rapid same-window
// filesystem events would.
//
// Several cases below pin down within-one-debounce-window regressions found
// in PR review: a file created then renamed before the debounce timer fired
// was queued as an add of the new name and then immediately un-queued by an
// unconditional cleanup step, so it never reached the UI at all; a file
// renamed then deleted before the timer fired reported the removal under
// the NEW name — a name the grid, and any sidecar move, never actually knew
// the file by — instead of the original one; and a pending rename whose
// target had gone missing by the time the file-stability probe ran (a
// rename racing another rename or a delete right as the timer fired) was
// silently dropped instead of reporting the original path removed, leaving
// a permanent ghost in the grid.

using System.Collections.Generic;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class LibraryChangeQueueTests
    {
        [Fact]
        public void CreateThenRenameInOneWindow_DrainsAsOneAddOfTheNewPath()
        {
            var queue = new LibraryChangeQueue();

            queue.QueueAdded(@"C:\lib\IMG_0001.CR3");
            queue.QueueRenamed(@"C:\lib\IMG_0001.CR3", @"C:\lib\Wedding_001.CR3");

            var drained = queue.Drain();

            var added = Assert.Single(drained.Added);
            Assert.Equal(@"C:\lib\Wedding_001.CR3", added);
            Assert.Empty(drained.Removed);
            Assert.Empty(drained.Renamed);
        }

        [Fact]
        public void RenameThenDeleteInOneWindow_DrainsAsOneRemovalOfTheOriginalPath()
        {
            var queue = new LibraryChangeQueue();

            queue.QueueRenamed(@"C:\lib\IMG_0001.CR3", @"C:\lib\Wedding_001.CR3");
            queue.QueueRemoved(@"C:\lib\Wedding_001.CR3");

            var drained = queue.Drain();

            var removed = Assert.Single(drained.Removed);
            Assert.Equal(@"C:\lib\IMG_0001.CR3", removed);
            Assert.Empty(drained.Added);
            Assert.Empty(drained.Renamed);
        }

        [Fact]
        public void RenameThenDeleteOfAChainedRename_DrainsAsOneRemovalOfTheOriginalPath()
        {
            var queue = new LibraryChangeQueue();

            // A -> B -> C (chain-collapses to A -> C), then C is deleted.
            queue.QueueRenamed(@"C:\lib\A.CR3", @"C:\lib\B.CR3");
            queue.QueueRenamed(@"C:\lib\B.CR3", @"C:\lib\C.CR3");
            queue.QueueRemoved(@"C:\lib\C.CR3");

            var drained = queue.Drain();

            var removed = Assert.Single(drained.Removed);
            Assert.Equal(@"C:\lib\A.CR3", removed);
            Assert.Empty(drained.Added);
            Assert.Empty(drained.Renamed);
        }

        [Fact]
        public void PlainRename_DrainsAsOneRename()
        {
            var queue = new LibraryChangeQueue();

            queue.QueueRenamed(@"C:\lib\A.CR3", @"C:\lib\B.CR3");

            var drained = queue.Drain();

            var renamed = Assert.Single(drained.Renamed);
            Assert.Equal(@"C:\lib\A.CR3", renamed.Key);
            Assert.Equal(@"C:\lib\B.CR3", renamed.Value);
            Assert.Empty(drained.Added);
            Assert.Empty(drained.Removed);
        }

        [Fact]
        public void ChainedRename_CollapsesToOneRenameFromTheOriginalToTheFinalName()
        {
            var queue = new LibraryChangeQueue();

            queue.QueueRenamed(@"C:\lib\A.CR3", @"C:\lib\B.CR3");
            queue.QueueRenamed(@"C:\lib\B.CR3", @"C:\lib\C.CR3");

            var drained = queue.Drain();

            var renamed = Assert.Single(drained.Renamed);
            Assert.Equal(@"C:\lib\A.CR3", renamed.Key);
            Assert.Equal(@"C:\lib\C.CR3", renamed.Value);
        }

        [Fact]
        public void Drain_ClearsThePendingState()
        {
            var queue = new LibraryChangeQueue();
            queue.QueueAdded(@"C:\lib\A.CR3");
            queue.QueueRenamed(@"C:\lib\B.CR3", @"C:\lib\C.CR3");

            queue.Drain();
            var second = queue.Drain();

            Assert.Empty(second.Added);
            Assert.Empty(second.Removed);
            Assert.Empty(second.Renamed);
        }

        [Fact]
        public void Requeue_SurvivesIntoTheNextDrain()
        {
            var queue = new LibraryChangeQueue();
            queue.Drain();    // start from empty

            queue.Requeue(
                new[] { @"C:\lib\Locked.CR3" },
                new[] { new KeyValuePair<string, string>(@"C:\lib\A.CR3", @"C:\lib\B.CR3") });

            var drained = queue.Drain();

            Assert.Equal(@"C:\lib\Locked.CR3", Assert.Single(drained.Added));
            var renamed = Assert.Single(drained.Renamed);
            Assert.Equal(@"C:\lib\A.CR3", renamed.Key);
            Assert.Equal(@"C:\lib\B.CR3", renamed.Value);
        }

        [Fact]
        public void DeleteThenRecreateInOneWindow_CancelsThePendingRemoval()
        {
            var queue = new LibraryChangeQueue();
            queue.Drain();

            queue.QueueRemoved(@"C:\lib\A.CR3");
            queue.QueueAdded(@"C:\lib\A.CR3");

            var drained = queue.Drain();

            Assert.Empty(drained.Removed);
            Assert.Single(drained.Added);
        }

        [Fact]
        public void Resolve_PendingRenameWhoseTargetIsMissingAtProbeTime_ReportsTheOldPathRemoved()
        {
            var queue = new LibraryChangeQueue();
            queue.QueueRenamed(@"C:\lib\A.CR3", @"C:\lib\B.CR3");
            var drained = queue.Drain();

            // Simulates the race: by the time the stability probe runs, the
            // renamed-to file (B) is already gone — another rename or a
            // delete landed right as the debounce timer fired.
            var resolved = LibraryChangeQueue.Resolve(
                drained, _ => LibraryChangeQueue.FileStability.Missing);

            var removed = Assert.Single(resolved.Removed);
            Assert.Equal(@"C:\lib\A.CR3", removed);
            Assert.Empty(resolved.Renamed);
            Assert.Empty(resolved.Added);
            Assert.Empty(resolved.UnstableRenamed);
        }

        [Fact]
        public void Resolve_StableRenameTarget_ReportsTheRename()
        {
            var queue = new LibraryChangeQueue();
            queue.QueueRenamed(@"C:\lib\A.CR3", @"C:\lib\B.CR3");
            var drained = queue.Drain();

            var resolved = LibraryChangeQueue.Resolve(
                drained, _ => LibraryChangeQueue.FileStability.Stable);

            var renamed = Assert.Single(resolved.Renamed);
            Assert.Equal(@"C:\lib\A.CR3", renamed.OldPath);
            Assert.Equal(@"C:\lib\B.CR3", renamed.NewPath);
            Assert.Empty(resolved.Removed);
        }

        [Fact]
        public void Resolve_LockedRenameTarget_StaysPendingRatherThanReportingEither()
        {
            var queue = new LibraryChangeQueue();
            queue.QueueRenamed(@"C:\lib\A.CR3", @"C:\lib\B.CR3");
            var drained = queue.Drain();

            var resolved = LibraryChangeQueue.Resolve(
                drained, _ => LibraryChangeQueue.FileStability.Locked);

            Assert.Empty(resolved.Renamed);
            Assert.Empty(resolved.Removed);
            var pending = Assert.Single(resolved.UnstableRenamed);
            Assert.Equal(@"C:\lib\A.CR3", pending.Key);
            Assert.Equal(@"C:\lib\B.CR3", pending.Value);
        }
    }
}

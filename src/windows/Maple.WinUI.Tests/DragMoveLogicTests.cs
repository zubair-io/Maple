// DragMoveLogicTests — pure collision detection (DetectCollisions,
// HasApplicableItem, IsAlreadyInDestination) plus ApplySequentialAsync's
// real-filesystem orchestration (real temp dirs, per CLAUDE.md's "No mocks"
// rule — same convention as BatchRenameLogicApplySequentialAsyncTests /
// RelocateCollisionTests).

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class DragMoveLogicTests
    {
        private static DragMoveSourceItem Item(string key, string dir, string fileName) =>
            new(key, dir, fileName, Path.Combine(dir, fileName));

        // --- IsAlreadyInDestination / HasApplicableItem ---

        [Fact]
        public void IsAlreadyInDestination_SameDirectory_True()
        {
            var item = Item("a", @"C:\lib\folder", "img.dng");
            Assert.True(DragMoveLogic.IsAlreadyInDestination(item, @"C:\lib\folder"));
        }

        [Fact]
        public void IsAlreadyInDestination_TrailingSeparatorAndCaseInsensitive_StillTrue()
        {
            var item = Item("a", @"C:\lib\Folder", "img.dng");
            Assert.True(DragMoveLogic.IsAlreadyInDestination(item, @"C:\LIB\folder\"));
        }

        [Fact]
        public void IsAlreadyInDestination_DifferentDirectory_False()
        {
            var item = Item("a", @"C:\lib\a", "img.dng");
            Assert.False(DragMoveLogic.IsAlreadyInDestination(item, @"C:\lib\b"));
        }

        [Fact]
        public void HasApplicableItem_WholeSelectionAlreadyThere_False()
        {
            var items = new[]
            {
                Item("a", @"C:\lib\target", "a.dng"),
                Item("b", @"C:\lib\target", "b.dng"),
            };
            Assert.False(DragMoveLogic.HasApplicableItem(items, @"C:\lib\target"));
        }

        [Fact]
        public void HasApplicableItem_OneItemElsewhere_True()
        {
            var items = new[]
            {
                Item("a", @"C:\lib\target", "a.dng"),
                Item("b", @"C:\lib\other", "b.dng"),
            };
            Assert.True(DragMoveLogic.HasApplicableItem(items, @"C:\lib\target"));
        }

        // --- DetectCollisions ---

        [Fact]
        public void DetectCollisions_OccupiedDestinationName_Flagged()
        {
            var items = new[] { Item("a", @"C:\lib\src", "img.dng") };
            var occupied = new HashSet<string> { @"C:\lib\dest\img.dng" };

            var colliding = DragMoveLogic.DetectCollisions(items, @"C:\lib\dest", occupied.Contains);

            Assert.Equal(new[] { "a" }, colliding);
        }

        [Fact]
        public void DetectCollisions_FreeDestinationName_NotFlagged()
        {
            var items = new[] { Item("a", @"C:\lib\src", "img.dng") };

            var colliding = DragMoveLogic.DetectCollisions(items, @"C:\lib\dest", _ => false);

            Assert.Empty(colliding);
        }

        [Fact]
        public void DetectCollisions_ItemAlreadyInDestination_NeverCountedAsCollision()
        {
            // Even if a same-named file "exists" at the destination (it's
            // literally the item itself), this isn't a collision — it's the
            // separate IsAlreadyInDestination no-op case ApplySequentialAsync
            // reports as Skipped with a different reason.
            var items = new[] { Item("a", @"C:\lib\dest", "img.dng") };

            var colliding = DragMoveLogic.DetectCollisions(items, @"C:\lib\dest", _ => true);

            Assert.Empty(colliding);
        }

        [Fact]
        public void DetectCollisions_MixedBatch_OnlyCollidingKeysReturned()
        {
            var items = new[]
            {
                Item("free", @"C:\lib\src", "free.dng"),
                Item("taken", @"C:\lib\src", "taken.dng"),
            };
            var occupied = new HashSet<string> { @"C:\lib\dest\taken.dng" };

            var colliding = DragMoveLogic.DetectCollisions(items, @"C:\lib\dest", occupied.Contains);

            Assert.Equal(new[] { "taken" }, colliding);
        }
    }

    // --- ApplySequentialAsync (real temp directories, real LocalFileOperations) ---
    public class DragMoveLogicApplySequentialAsyncTests : IDisposable
    {
        private readonly string _root;
        private readonly string _src;
        private readonly string _dest;

        public DragMoveLogicApplySequentialAsyncTests()
        {
            _root = Path.Combine(Path.GetTempPath(), "maple-winui-dragmove-" + Guid.NewGuid().ToString("N"));
            _src = Path.Combine(_root, "src");
            _dest = Path.Combine(_root, "dest");
            Directory.CreateDirectory(_src);
            Directory.CreateDirectory(_dest);
        }

        public void Dispose()
        {
            try { Directory.Delete(_root, recursive: true); }
            catch (IOException) { }
        }

        private DragMoveSourceItem WriteSourceItem(string key, string fileName, string content)
        {
            var full = Path.Combine(_src, fileName);
            File.WriteAllText(full, content);
            return new DragMoveSourceItem(key, _src, fileName, full);
        }

        [Fact]
        public async Task Move_NoCollision_RelocatesAndDeletesSource()
        {
            var a = WriteSourceItem("a", "img.dng", "bytes");

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { a }, _dest, RelocateMode.Move,
                Array.Empty<string>(), DragMoveCollisionChoice.KeepBoth);

            Assert.Equal(DragMoveOutcomeKind.Relocated, outcomes[0].Kind);
            Assert.Equal(Path.Combine(_dest, "img.dng"), outcomes[0].NewPath);
            Assert.False(File.Exists(a.CurrentPath));
            Assert.True(File.Exists(Path.Combine(_dest, "img.dng")));
        }

        [Fact]
        public async Task Copy_NoCollision_DuplicatesAndKeepsSource()
        {
            var a = WriteSourceItem("a", "img.dng", "bytes");

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { a }, _dest, RelocateMode.Copy,
                Array.Empty<string>(), DragMoveCollisionChoice.KeepBoth);

            Assert.Equal(DragMoveOutcomeKind.Relocated, outcomes[0].Kind);
            Assert.True(File.Exists(a.CurrentPath));
            Assert.True(File.Exists(Path.Combine(_dest, "img.dng")));
        }

        [Fact]
        public async Task AlreadyInDestination_SkippedWithoutTouchingTheFile()
        {
            var full = Path.Combine(_dest, "img.dng");
            File.WriteAllText(full, "bytes");
            var item = new DragMoveSourceItem("a", _dest, "img.dng", full);

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { item }, _dest, RelocateMode.Move,
                Array.Empty<string>(), DragMoveCollisionChoice.KeepBoth);

            Assert.Equal(DragMoveOutcomeKind.Skipped, outcomes[0].Kind);
            Assert.True(File.Exists(full));
        }

        [Fact]
        public async Task CollisionWithSkipChoice_SkipsOnlyCollidingItemsAndAppliesTheRest()
        {
            File.WriteAllText(Path.Combine(_dest, "taken.dng"), "old");
            var taken = WriteSourceItem("taken", "taken.dng", "new");
            var free = WriteSourceItem("free", "free.dng", "free-bytes");
            var colliding = new[] { "taken" };

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { taken, free }, _dest, RelocateMode.Move,
                colliding, DragMoveCollisionChoice.Skip);

            Assert.Equal(DragMoveOutcomeKind.Skipped, outcomes[0].Kind);
            Assert.Equal(DragMoveOutcomeKind.Relocated, outcomes[1].Kind);
            // The skipped item's source is untouched and the destination's
            // pre-existing occupant survives unmodified.
            Assert.True(File.Exists(taken.CurrentPath));
            Assert.Equal("old", File.ReadAllText(Path.Combine(_dest, "taken.dng")));
            Assert.True(File.Exists(Path.Combine(_dest, "free.dng")));
        }

        [Fact]
        public async Task CollisionWithReplaceChoice_OverwritesTheDestination()
        {
            File.WriteAllText(Path.Combine(_dest, "taken.dng"), "old");
            var taken = WriteSourceItem("taken", "taken.dng", "new");
            var colliding = new[] { "taken" };

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { taken }, _dest, RelocateMode.Move,
                colliding, DragMoveCollisionChoice.Replace);

            Assert.Equal(DragMoveOutcomeKind.Relocated, outcomes[0].Kind);
            Assert.Equal("new", File.ReadAllText(Path.Combine(_dest, "taken.dng")));
            Assert.False(File.Exists(taken.CurrentPath));
        }

        [Fact]
        public async Task CollisionWithKeepBothChoice_AutoSuffixesTheNewCopy()
        {
            File.WriteAllText(Path.Combine(_dest, "taken.dng"), "old");
            var taken = WriteSourceItem("taken", "taken.dng", "new");
            var colliding = new[] { "taken" };

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { taken }, _dest, RelocateMode.Move,
                colliding, DragMoveCollisionChoice.KeepBoth);

            Assert.Equal(DragMoveOutcomeKind.Relocated, outcomes[0].Kind);
            Assert.Equal(Path.Combine(_dest, "taken.1.dng"), outcomes[0].NewPath);
            Assert.Equal("old", File.ReadAllText(Path.Combine(_dest, "taken.dng")));
            Assert.Equal("new", File.ReadAllText(Path.Combine(_dest, "taken.1.dng")));
        }

        [Fact]
        public async Task OneItemsFailure_DoesNotStopTheRemainingItems()
        {
            var a = WriteSourceItem("a", "a.dng", "A");
            var missing = new DragMoveSourceItem("missing", _src, "gone.dng", Path.Combine(_src, "gone.dng"));
            var c = WriteSourceItem("c", "c.dng", "C");

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { a, missing, c }, _dest, RelocateMode.Move,
                Array.Empty<string>(), DragMoveCollisionChoice.KeepBoth);

            Assert.Equal(DragMoveOutcomeKind.Relocated, outcomes[0].Kind);
            Assert.Equal(DragMoveOutcomeKind.Error, outcomes[1].Kind);
            Assert.NotNull(outcomes[1].Error);
            Assert.Equal(DragMoveOutcomeKind.Relocated, outcomes[2].Kind);
        }

        [Fact]
        public async Task ProgressCallback_FiresOncePerItemInOrder()
        {
            var a = WriteSourceItem("a", "a.dng", "A");
            var b = WriteSourceItem("b", "b.dng", "B");
            var progress = new List<(int Done, int Total)>();

            await DragMoveLogic.ApplySequentialAsync(
                new[] { a, b }, _dest, RelocateMode.Move,
                Array.Empty<string>(), DragMoveCollisionChoice.KeepBoth,
                (done, total) => progress.Add((done, total)));

            Assert.Equal(new[] { (1, 2), (2, 2) }, progress);
        }

        [Fact]
        public async Task SidecarFollowsThePrimaryOnDragMove()
        {
            var a = WriteSourceItem("a", "img.dng", "raw-bytes");
            File.WriteAllText(Path.Combine(_src, "img.xmp"), "<xmp/>");

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { a }, _dest, RelocateMode.Move,
                Array.Empty<string>(), DragMoveCollisionChoice.KeepBoth);

            Assert.Equal(DragMoveOutcomeKind.Relocated, outcomes[0].Kind);
            Assert.True(File.Exists(Path.Combine(_dest, "img.xmp")));
            Assert.False(File.Exists(Path.Combine(_src, "img.xmp")));
        }

        [Fact]
        public async Task IntraBatchSameBasenameCollision_NeverInheritsTheBatchWideReplaceChoice()
        {
            // The exact data-loss scenario found in review: two DIFFERENT
            // source folders each contain "img.dng". Neither collides with
            // the destination's pre-existing contents at scan time (the
            // destination has no "img.dng" yet), so DetectCollisions could
            // never have flagged this pair — only the UNRELATED
            // pre-existing "taken.dng" is a known collision. If the
            // sequential apply blindly applied the batch-wide Replace
            // (chosen for "taken.dng") to every live collision it hits,
            // the second "img.dng" would silently overwrite the first
            // one's freshly-moved file the moment it lands — destroying a
            // photo the user never approved touching. Both must survive.
            var srcA = Path.Combine(_root, "srcA");
            var srcB = Path.Combine(_root, "srcB");
            Directory.CreateDirectory(srcA);
            Directory.CreateDirectory(srcB);
            var fileA = Path.Combine(srcA, "img.dng");
            var fileB = Path.Combine(srcB, "img.dng");
            File.WriteAllText(fileA, "from-A");
            File.WriteAllText(fileB, "from-B");
            var itemA = new DragMoveSourceItem("a", srcA, "img.dng", fileA);
            var itemB = new DragMoveSourceItem("b", srcB, "img.dng", fileB);
            var unrelated = WriteSourceItem("taken", "taken.dng", "new-taken");
            File.WriteAllText(Path.Combine(_dest, "taken.dng"), "old-taken");

            // Only "taken" was ever flagged by the pre-scan — "img.dng" from
            // either source was never shown to the user.
            var collidingKeys = new[] { "taken" };

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { itemA, itemB, unrelated }, _dest, RelocateMode.Move,
                collidingKeys, DragMoveCollisionChoice.Replace);

            Assert.All(outcomes, o => Assert.Equal(DragMoveOutcomeKind.Relocated, o.Kind));
            // Nothing was silently lost: both "from-A" and "from-B" survive
            // SOMEWHERE under the destination (auto-suffixed apart, not one
            // overwriting the other).
            var destContents = Directory.GetFiles(_dest)
                .Where(p => Path.GetFileName(p).StartsWith("img", StringComparison.Ordinal))
                .Select(File.ReadAllText)
                .ToList();
            Assert.Contains("from-A", destContents);
            Assert.Contains("from-B", destContents);
            // The collision the user WAS actually asked about (and chose
            // Replace for) is genuinely replaced.
            Assert.Equal("new-taken", File.ReadAllText(Path.Combine(_dest, "taken.dng")));
        }

        [Fact]
        public async Task IntraBatchSameBasenameCollision_SkipChoiceStillDoesNotLoseTheSecondItem()
        {
            // Same shape as the Replace regression above, but with Skip
            // chosen for the (unrelated) known collision — the unseen
            // intra-batch collision must still resolve safely (auto-suffix)
            // rather than inheriting Skip and leaving the second item
            // stranded with no record of why.
            var srcA = Path.Combine(_root, "srcA");
            var srcB = Path.Combine(_root, "srcB");
            Directory.CreateDirectory(srcA);
            Directory.CreateDirectory(srcB);
            var fileA = Path.Combine(srcA, "img.dng");
            var fileB = Path.Combine(srcB, "img.dng");
            File.WriteAllText(fileA, "from-A");
            File.WriteAllText(fileB, "from-B");
            var itemA = new DragMoveSourceItem("a", srcA, "img.dng", fileA);
            var itemB = new DragMoveSourceItem("b", srcB, "img.dng", fileB);

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { itemA, itemB }, _dest, RelocateMode.Move,
                Array.Empty<string>(), DragMoveCollisionChoice.Skip);

            Assert.All(outcomes, o => Assert.Equal(DragMoveOutcomeKind.Relocated, o.Kind));
            var destContents = Directory.GetFiles(_dest).Select(File.ReadAllText).ToList();
            Assert.Contains("from-A", destContents);
            Assert.Contains("from-B", destContents);
        }
    }
}

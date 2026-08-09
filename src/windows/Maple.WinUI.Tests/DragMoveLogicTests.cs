// DragMoveLogicTests — pure collision detection (DetectCollisions,
// HasApplicableItem, IsAlreadyInDestination). The real-filesystem
// ApplySequentialAsync orchestration lives in the companion
// DragMoveLogicApplySequentialAsyncTests.cs (split out to stay under this
// project's 400-line file-budget soft cap once the intra-batch collision
// regression tests landed).

using System.Collections.Generic;
using System.IO;
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

        // --- ShouldAcceptDrop ---

        [Theory]
        [InlineData(true, true, true)]
        [InlineData(true, false, false)]
        [InlineData(false, true, false)]
        [InlineData(false, false, false)]
        public void ShouldAcceptDrop_RequiresBothInternalOriginAndApplicableTarget(
            bool isInternalDrag, bool hasApplicableTarget, bool expected)
        {
            // Guards a real regression: an external drag (e.g. Windows
            // Explorer) reaching OnFolderDrop with a stale-but-nonempty
            // internal payload must never be accepted just because the
            // target happens to be valid — BOTH conditions are required,
            // not just one.
            Assert.Equal(expected, DragMoveLogic.ShouldAcceptDrop(isInternalDrag, hasApplicableTarget));
        }

        // --- IsEligibleDropTargetNode ---

        [Fact]
        public void IsEligibleDropTargetNode_NormalFolder_IsTrue()
        {
            Assert.True(DragMoveLogic.IsEligibleDropTargetNode(
                isPlaceholder: false, isUnavailable: false, hasPath: true));
        }

        [Fact]
        public void IsEligibleDropTargetNode_Placeholder_IsFalse()
        {
            Assert.False(DragMoveLogic.IsEligibleDropTargetNode(
                isPlaceholder: true, isUnavailable: false, hasPath: true));
        }

        [Fact]
        public void IsEligibleDropTargetNode_UnavailableRoot_IsFalse()
        {
            // #2754: an offline/missing library root (#2651) still
            // renders a row, but dragging a real photo onto it must not be
            // accepted — there's no directory there to relocate into.
            Assert.False(DragMoveLogic.IsEligibleDropTargetNode(
                isPlaceholder: false, isUnavailable: true, hasPath: true));
        }

        [Fact]
        public void IsEligibleDropTargetNode_EmptyPath_IsFalse()
        {
            Assert.False(DragMoveLogic.IsEligibleDropTargetNode(
                isPlaceholder: false, isUnavailable: false, hasPath: false));
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
}

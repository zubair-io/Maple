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

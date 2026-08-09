// FolderTreeCrudLogicTests — the pure path-string helpers behind the
// sources-tree context flyout (#2647): resolving a node's owning library
// root, same-or-descendant containment, descendant-path rewriting after a
// rename, and the Recycle-Bin-vs-Maple's-Trash confirmation copy.

using System.IO;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class FolderTreeCrudLogicTests
    {
        private static readonly string Root = Path.Combine("C:" + Path.DirectorySeparatorChar, "Library");
        private static readonly string OtherRoot = Path.Combine("D:" + Path.DirectorySeparatorChar, "Backup");

        [Fact]
        public void FindLibraryRoot_ExactRoot_ReturnsItself()
        {
            var roots = new[] { Root, OtherRoot };

            Assert.Equal(Root, FolderTreeCrudLogic.FindLibraryRoot(roots, Root));
        }

        [Fact]
        public void FindLibraryRoot_Descendant_ReturnsOwningRoot()
        {
            var roots = new[] { Root, OtherRoot };
            var descendant = Path.Combine(Root, "2026", "Vacation");

            Assert.Equal(Root, FolderTreeCrudLogic.FindLibraryRoot(roots, descendant));
        }

        [Fact]
        public void FindLibraryRoot_UnrelatedPath_ReturnsNull()
        {
            var roots = new[] { Root };

            Assert.Null(FolderTreeCrudLogic.FindLibraryRoot(roots, Path.Combine("E:" + Path.DirectorySeparatorChar, "Elsewhere")));
        }

        [Fact]
        public void FindLibraryRoot_NestedRoots_PicksLongestMatch()
        {
            var nestedRoot = Path.Combine(Root, "Nested");
            var roots = new[] { Root, nestedRoot };
            var deepPath = Path.Combine(nestedRoot, "Sub");

            Assert.Equal(nestedRoot, FolderTreeCrudLogic.FindLibraryRoot(roots, deepPath));
        }

        [Fact]
        public void IsSameOrDescendant_SamePathDifferentCasing_IsTrue()
        {
            Assert.True(FolderTreeCrudLogic.IsSameOrDescendant(Root, Root.ToUpperInvariant()));
        }

        [Fact]
        public void IsSameOrDescendant_Child_IsTrue()
        {
            Assert.True(FolderTreeCrudLogic.IsSameOrDescendant(Root, Path.Combine(Root, "Sub")));
        }

        [Fact]
        public void IsSameOrDescendant_SiblingWithSharedPrefix_IsFalse()
        {
            // "C:\Library" must not swallow "C:\LibraryOther" via a naive
            // string-prefix check without the separator.
            var sibling = Path.Combine("C:" + Path.DirectorySeparatorChar, "LibraryOther");

            Assert.False(FolderTreeCrudLogic.IsSameOrDescendant(Root, sibling));
        }

        [Fact]
        public void IsSameOrDescendant_UnrelatedPath_IsFalse()
        {
            Assert.False(FolderTreeCrudLogic.IsSameOrDescendant(Root, OtherRoot));
        }

        [Fact]
        public void RewriteDescendantPath_ExactMatch_ReturnsNewAncestor()
        {
            var renamed = Path.Combine("C:" + Path.DirectorySeparatorChar, "Renamed");

            Assert.Equal(renamed, FolderTreeCrudLogic.RewriteDescendantPath(Root, renamed, Root));
        }

        [Fact]
        public void RewriteDescendantPath_Descendant_PreservesRelativeSuffix()
        {
            var renamed = Path.Combine("C:" + Path.DirectorySeparatorChar, "Renamed");
            var browsed = Path.Combine(Root, "2026", "Vacation");

            var rewritten = FolderTreeCrudLogic.RewriteDescendantPath(Root, renamed, browsed);

            Assert.Equal(Path.Combine(renamed, "2026", "Vacation"), rewritten);
        }

        [Fact]
        public void TrashDestinationDescription_LocalFixedDrive_NamesRecycleBin()
        {
            Assert.Equal("the Recycle Bin", FolderTreeCrudLogic.TrashDestinationDescription(isOnLocalFixedDrive: true));
        }

        [Fact]
        public void TrashDestinationDescription_NotLocalFixedDrive_NamesMapleTrash()
        {
            var description = FolderTreeCrudLogic.TrashDestinationDescription(isOnLocalFixedDrive: false);

            Assert.Contains(".maple", description);
            Assert.Contains("trash", description);
        }

        // Review finding (#2647): a library root has no non-circular
        // `.maple/trash` fallback (its parent sits outside the library, so
        // TrashPaths.TrashDestinationDir always rejects it — see
        // FolderCrudTests.
        // DeleteFolderAsync_TrashingTheLibraryRootItself_RecycleBinUnavailable_ThrowsInvalidDestination
        // for that failure pinned at the LocalFileOperations layer). Only
        // the real Recycle Bin can trash a root at all.

        [Fact]
        public void RootTrashUnsupported_RootWithoutLocalFixedDrive_IsTrue()
        {
            Assert.True(FolderTreeCrudLogic.RootTrashUnsupported(isLibraryRoot: true, isOnLocalFixedDrive: false));
        }

        [Fact]
        public void RootTrashUnsupported_RootOnLocalFixedDrive_IsFalse()
        {
            Assert.False(FolderTreeCrudLogic.RootTrashUnsupported(isLibraryRoot: true, isOnLocalFixedDrive: true));
        }

        [Fact]
        public void RootTrashUnsupported_NonRootRegardlessOfDriveType_IsFalse()
        {
            // A subfolder always has a valid `.maple/trash` fallback under
            // its own library root, so the gate never applies to it.
            Assert.False(FolderTreeCrudLogic.RootTrashUnsupported(isLibraryRoot: false, isOnLocalFixedDrive: false));
            Assert.False(FolderTreeCrudLogic.RootTrashUnsupported(isLibraryRoot: false, isOnLocalFixedDrive: true));
        }
    }
}

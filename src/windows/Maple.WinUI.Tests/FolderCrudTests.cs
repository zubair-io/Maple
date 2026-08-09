// FolderCrudTests — real temp directories, real folders. Covers create,
// rename, move, the self-subtree guard, and recursive trash-folder-delete
// fallback (issue #2632).

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class FolderCrudTests : IDisposable
    {
        private readonly string _dir;

        public FolderCrudTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-folder-crud-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        [Fact]
        public void CreateFolder_MakesNewDirectory()
        {
            var created = LocalFileOperations.CreateFolder("Vacation 2026", _dir);

            Assert.True(Directory.Exists(created));
            Assert.Equal(Path.Combine(_dir, "Vacation 2026"), created);
        }

        [Fact]
        public void CreateFolder_Collision_ThrowsDestinationExists()
        {
            Directory.CreateDirectory(Path.Combine(_dir, "Existing"));

            var ex = Assert.Throws<FileOperationException>(
                () => LocalFileOperations.CreateFolder("Existing", _dir));

            Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
        }

        [Fact]
        public void RenameFolder_RenamesInPlace()
        {
            var folder = Path.Combine(_dir, "Old Name");
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder, "photo.dng"), "bytes");

            var renamed = LocalFileOperations.RenameFolder(folder, "New Name");

            Assert.Equal(Path.Combine(_dir, "New Name"), renamed);
            Assert.True(File.Exists(Path.Combine(renamed, "photo.dng")));
            Assert.False(Directory.Exists(folder));
        }

        [Fact]
        public void MoveFolder_MovesIntoNewParent()
        {
            var folder = Path.Combine(_dir, "Source");
            var newParent = Path.Combine(_dir, "Destination");
            Directory.CreateDirectory(folder);
            Directory.CreateDirectory(newParent);
            File.WriteAllText(Path.Combine(folder, "photo.dng"), "bytes");

            var moved = LocalFileOperations.MoveFolder(folder, newParent);

            Assert.Equal(Path.Combine(newParent, "Source"), moved);
            Assert.True(File.Exists(Path.Combine(moved, "photo.dng")));
        }

        [Fact]
        public void MoveFolder_IntoOwnSubtree_ThrowsInvalidDestination()
        {
            var folder = Path.Combine(_dir, "Parent");
            var child = Path.Combine(folder, "Child");
            Directory.CreateDirectory(child);

            var ex = Assert.Throws<FileOperationException>(
                () => LocalFileOperations.MoveFolder(folder, child));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
            Assert.True(Directory.Exists(folder)); // untouched
        }

        [Fact]
        public void MoveFolder_IntoItself_ThrowsInvalidDestination()
        {
            var folder = Path.Combine(_dir, "Solo");
            Directory.CreateDirectory(folder);

            var ex = Assert.Throws<FileOperationException>(
                () => LocalFileOperations.MoveFolder(folder, folder));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
        }

        [Fact]
        public void MoveFolder_DestinationOccupied_ThrowsDestinationExists()
        {
            var folder = Path.Combine(_dir, "Source");
            var newParent = Path.Combine(_dir, "Destination");
            Directory.CreateDirectory(folder);
            Directory.CreateDirectory(Path.Combine(newParent, "Source"));

            var ex = Assert.Throws<FileOperationException>(
                () => LocalFileOperations.MoveFolder(folder, newParent));

            Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
        }

        [Fact]
        public void RenameFolder_CaseOnlyRename_PerformsAtomicRenameWithNewCasing()
        {
            // NTFS is case-insensitive-but-case-preserving: renaming
            // "Photos" -> "photos" is a real, meaningful rename (updating
            // the STORED casing), not a same-path no-op and not a
            // "destination occupied" collision against itself.
            var folder = Path.Combine(_dir, "Photos");
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder, "img.dng"), "bytes");

            var renamed = LocalFileOperations.RenameFolder(folder, "photos");

            Assert.Equal(Path.Combine(_dir, "photos"), renamed);
            Assert.True(File.Exists(Path.Combine(renamed, "img.dng")));
            // The directory listing itself must reflect the NEW casing —
            // proof this went through Directory.Move, not a silent no-op.
            var entry = Directory.GetDirectories(_dir).Single();
            Assert.Equal("photos", Path.GetFileName(entry));
        }

        [Fact]
        public void MoveFolder_IntoOwnSubtreeCaseVariant_StillRefused()
        {
            // The case-insensitive complement of the subtree guard: NTFS
            // resolves `C:\Parent\Child` and `c:\parent\child` to the same
            // location, so a case-sensitive guard alone would let this
            // through.
            var folder = Path.Combine(_dir, "Parent");
            var childLower = Path.Combine(_dir.ToLowerInvariant(), "parent", "child");
            Directory.CreateDirectory(Path.Combine(folder, "Child"));

            var ex = Assert.Throws<FileOperationException>(
                () => LocalFileOperations.MoveFolder(folder, childLower));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
            Assert.True(Directory.Exists(folder));
        }

        [Fact]
        public void CreateFolder_ReservedDeviceName_ThrowsInvalidDestination()
        {
            var ex = Assert.Throws<FileOperationException>(
                () => LocalFileOperations.CreateFolder("NUL", _dir));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
            Assert.False(Directory.Exists(Path.Combine(_dir, "NUL")));
        }

        [Fact]
        public void MoveFolder_NewNameIsReservedDeviceName_ThrowsInvalidDestinationAndLeavesSourceInPlace()
        {
            var folder = Path.Combine(_dir, "Source");
            Directory.CreateDirectory(folder);

            var ex = Assert.Throws<FileOperationException>(
                () => LocalFileOperations.MoveFolder(folder, _dir, "COM1"));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
            Assert.True(Directory.Exists(folder));
        }

        [Fact]
        public async Task DeleteFolderAsync_RecycleBinUnavailable_FallsBackToMapleTrashPreservingContents()
        {
            var libraryRoot = Path.Combine(_dir, "Library");
            var folder = Path.Combine(libraryRoot, "Album");
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder, "photo.dng"), "bytes");
            File.WriteAllText(Path.Combine(folder, "photo.xmp"), "<xmp/>");

            var fakeRecycleBin = new FakeRecycleBinService { Succeeds = false };
            var trashedTo = await LocalFileOperations.DeleteFolderAsync(folder, libraryRoot, fakeRecycleBin);

            Assert.False(Directory.Exists(folder));
            Assert.Equal(Path.Combine(libraryRoot, ".maple", "trash", "Album"), trashedTo);
            Assert.True(File.Exists(Path.Combine(trashedTo, "photo.dng")));
            Assert.True(File.Exists(Path.Combine(trashedTo, "photo.xmp")));
        }

        [Fact]
        public async Task DeleteFolderAsync_LocalFixedDrive_UsesRecycleBinWhenAvailable()
        {
            var libraryRoot = Path.Combine(_dir, "Library");
            var folder = Path.Combine(libraryRoot, "Album");
            Directory.CreateDirectory(folder);

            var fakeRecycleBin = new FakeRecycleBinService { Succeeds = true };
            var result = await LocalFileOperations.DeleteFolderAsync(folder, libraryRoot, fakeRecycleBin);

            Assert.Equal(folder, result); // recycle bin path — original location is the semantic result
            Assert.Contains(folder, fakeRecycleBin.Attempts);
        }

        [Fact]
        public async Task DeleteFolderAsync_TrashingTheLibraryRootItself_RecycleBinUnavailable_ThrowsInvalidDestination()
        {
            // Review finding (#2647 review round): trashing a library ROOT
            // via the `.maple/trash` fallback is fundamentally different
            // from trashing a subfolder — see
            // DeleteFolderAsync_RecycleBinUnavailable_FallsBackToMapleTrashPreservingContents
            // above for the ordinary subfolder case, which DOES work.
            // TrashDestinationDir computes a trash location from the item's
            // PARENT directory; a root's parent sits OUTSIDE the library
            // entirely, so the computed destination fails the "is under
            // library root" check this same method enforces on every other
            // path. This test pins that failure mode so a future change
            // doesn't silently "fix" it into something that actually moves a
            // root's trash outside the library without a deliberate design
            // decision (restore semantics for a root's own trash are
            // themselves an open question — see FolderTreeCrudLogic.
            // RootTrashUnsupported's doc comment for why Windows instead
            // gates a root to Recycle-Bin-only at the call site rather than
            // relying on this fallback).
            var libraryRoot = Path.Combine(_dir, "Library");
            Directory.CreateDirectory(libraryRoot);
            File.WriteAllText(Path.Combine(libraryRoot, "photo.dng"), "bytes");

            var fakeRecycleBin = new FakeRecycleBinService { Succeeds = false };

            var ex = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.DeleteFolderAsync(libraryRoot, libraryRoot, fakeRecycleBin));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
            Assert.True(Directory.Exists(libraryRoot)); // untouched — the throw happens before any move
        }
    }
}

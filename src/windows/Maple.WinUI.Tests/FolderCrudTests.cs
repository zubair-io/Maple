// FolderCrudTests — real temp directories, real folders. Covers create,
// rename, move, the self-subtree guard, and recursive trash-folder-delete
// fallback (issue #2632).

using System;
using System.IO;
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
    }
}

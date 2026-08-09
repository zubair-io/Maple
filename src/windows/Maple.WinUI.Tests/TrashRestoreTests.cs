// TrashRestoreTests — real temp directories, real files. Covers the restore
// half of #2654's `.maple/trash/<rel>` fallback (#2632 shipped trash-IN
// only): inverting TrashDestinationDir's path math back to the original
// relative location, the sidecar following the primary on restore the same
// way it follows on trash, and the `.restored[.N]` collision naming
// mirroring the API's `pickFreeRestoredPath`.

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class TrashRestoreTests : IDisposable
    {
        private readonly string _dir;

        public TrashRestoreTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-trash-restore-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string WriteFile(string relPath, string content)
        {
            var full = Path.Combine(_dir, relPath);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        [Fact]
        public async Task RestoreFromMapleTrashAsync_RestoresPrimaryAndSidecarToOriginalLocation()
        {
            var libraryRoot = _dir;
            var trashedRaw = WriteFile(Path.Combine(".maple", "trash", "Album", "photo.dng"), "bytes");
            var trashedSidecar = WriteFile(Path.Combine(".maple", "trash", "Album", "photo.xmp"), "<xmp/>");

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(trashedRaw, libraryRoot);

            var expectedRaw = Path.Combine(libraryRoot, "Album", "photo.dng");
            var expectedSidecar = Path.Combine(libraryRoot, "Album", "photo.xmp");
            Assert.Equal(expectedRaw, outcome.PrimaryPath);
            Assert.Equal(expectedSidecar, outcome.SidecarPath);
            Assert.True(File.Exists(expectedRaw));
            Assert.True(File.Exists(expectedSidecar));
            Assert.False(File.Exists(trashedRaw));
            Assert.False(File.Exists(trashedSidecar));
        }

        [Fact]
        public async Task RestoreFromMapleTrashAsync_ItemAtTrashRoot_RestoresToLibraryRoot()
        {
            var libraryRoot = _dir;
            var trashedRaw = WriteFile(Path.Combine(".maple", "trash", "photo.dng"), "bytes");

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(trashedRaw, libraryRoot);

            Assert.Equal(Path.Combine(libraryRoot, "photo.dng"), outcome.PrimaryPath);
        }

        [Fact]
        public async Task RestoreFromMapleTrashAsync_OriginalFolderNoLongerExists_RecreatesIt()
        {
            var libraryRoot = _dir;
            var trashedRaw = WriteFile(Path.Combine(".maple", "trash", "GoneFolder", "photo.dng"), "bytes");
            // The original "GoneFolder" was never recreated on disk — restore must make it.

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(trashedRaw, libraryRoot);

            Assert.Equal(Path.Combine(libraryRoot, "GoneFolder", "photo.dng"), outcome.PrimaryPath);
            Assert.True(File.Exists(outcome.PrimaryPath));
        }

        [Fact]
        public async Task RestoreFromMapleTrashAsync_CollidesWithExistingFileAtOriginalLocation_AddsRestoredSuffix()
        {
            var libraryRoot = _dir;
            WriteFile("photo.dng", "current occupant");
            var trashedRaw = WriteFile(Path.Combine(".maple", "trash", "photo.dng"), "restored content");

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(trashedRaw, libraryRoot);

            Assert.Equal(Path.Combine(libraryRoot, "photo.restored.dng"), outcome.PrimaryPath);
            Assert.Equal("current occupant", File.ReadAllText(Path.Combine(libraryRoot, "photo.dng")));
            Assert.Equal("restored content", File.ReadAllText(outcome.PrimaryPath));
        }

        [Fact]
        public async Task RestoreFromMapleTrashAsync_CollidesWithAnAlreadyRestoredFile_AddsNumberedRestoredSuffix()
        {
            var libraryRoot = _dir;
            WriteFile("photo.dng", "current occupant");
            WriteFile("photo.restored.dng", "first restore");
            var trashedRaw = WriteFile(Path.Combine(".maple", "trash", "photo.dng"), "second restore");

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(trashedRaw, libraryRoot);

            Assert.Equal(Path.Combine(libraryRoot, "photo.restored.1.dng"), outcome.PrimaryPath);
            Assert.Equal("first restore", File.ReadAllText(Path.Combine(libraryRoot, "photo.restored.dng")));
        }

        [Fact]
        public void ComputeOriginalRelativePath_ItemNotInsideMapleTrash_ThrowsInvalidDestination()
        {
            var libraryRoot = _dir;
            var outsideItem = WriteFile("Album\\photo.dng", "bytes");

            var ex = Assert.Throws<FileOperationException>(
                () => LocalFileOperations.ComputeOriginalRelativePath(outsideItem, libraryRoot));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
        }

        [Fact]
        public void ComputeOriginalRelativePath_TrashRootItself_ThrowsInvalidDestination()
        {
            var libraryRoot = _dir;
            Directory.CreateDirectory(Path.Combine(libraryRoot, ".maple", "trash"));

            var ex = Assert.Throws<FileOperationException>(() => LocalFileOperations.ComputeOriginalRelativePath(
                Path.Combine(libraryRoot, ".maple", "trash"), libraryRoot));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
        }

        [Fact]
        public void PickFreeRestoredBasename_NoCollision_ReturnsRestoredSuffixUnnumbered()
        {
            var basename = LocalFileOperations.PickFreeRestoredBasename(_dir, "photo.dng");
            Assert.Equal("photo.restored.dng", basename);
        }
    }
}

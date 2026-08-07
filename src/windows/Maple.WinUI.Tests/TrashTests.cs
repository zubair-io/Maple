// TrashTests — real temp directories, real files; the Recycle Bin itself is
// faked (see `Support/FakeRecycleBinService.cs` for why that's the right
// seam) so a test run never touches a real machine's actual Recycle Bin.
// Covers both branches of issue #2632's trash design: local-fixed-drive
// delete via the OS Recycle Bin, and the `.maple/trash/<rel>` fallback for
// paths where it's unavailable (modeled here via a Recycle Bin that reports
// failure, standing in for a network share).

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class TrashTests : IDisposable
    {
        private readonly string _dir;

        public TrashTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-trash-" + Guid.NewGuid().ToString("N"));
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
        public async Task TrashAsync_LocalFixedDrive_RoutesPrimaryAndSidecarThroughRecycleBin()
        {
            var libraryRoot = _dir;
            var raw = WriteFile("photo.dng", "bytes");
            var sidecar = WriteFile("photo.xmp", "<xmp/>");
            var fake = new FakeRecycleBinService { Succeeds = true };

            var outcome = await LocalFileOperations.TrashAsync(raw, libraryRoot, fake);

            Assert.Contains(raw, fake.Attempts);
            Assert.Contains(sidecar, fake.Attempts);
            Assert.True(outcome.SidecarFollowed);
        }

        [Fact]
        public async Task TrashAsync_RecycleBinUnavailable_FallsBackToMapleTrashFolder()
        {
            var libraryRoot = _dir;
            var raw = WriteFile("Album\\photo.dng", "bytes");
            WriteFile("Album\\photo.xmp", "<xmp/>");
            var fake = new FakeRecycleBinService { Succeeds = false };

            var outcome = await LocalFileOperations.TrashAsync(raw, libraryRoot, fake);

            Assert.Empty(fake.Attempts);
            Assert.Equal(Path.Combine(libraryRoot, ".maple", "trash", "Album", "photo.dng"), outcome.PrimaryPath);
            Assert.True(File.Exists(outcome.PrimaryPath));
            Assert.True(File.Exists(outcome.SidecarPath!));
            Assert.False(File.Exists(raw));
        }

        [Fact]
        public async Task TrashAsync_ItemAtLibraryRoot_LandsDirectlyInTrashRoot()
        {
            var libraryRoot = _dir;
            var raw = WriteFile("photo.dng", "bytes");
            var fake = new FakeRecycleBinService { Succeeds = false };

            var outcome = await LocalFileOperations.TrashAsync(raw, libraryRoot, fake);

            Assert.Equal(Path.Combine(libraryRoot, ".maple", "trash", "photo.dng"), outcome.PrimaryPath);
        }

        [Fact]
        public void TrashDestinationDir_ItemOutsideLibraryRoot_ThrowsInvalidDestination()
        {
            var libraryRoot = Path.Combine(_dir, "Library");
            var outsideItem = Path.Combine(_dir, "Elsewhere", "photo.dng");
            Directory.CreateDirectory(libraryRoot);
            Directory.CreateDirectory(Path.GetDirectoryName(outsideItem)!);

            var ex = Assert.Throws<FileOperationException>(
                () => TrashPaths.TrashDestinationDir(outsideItem, libraryRoot));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
        }

        [Fact]
        public async Task TrashAsync_CollidingWithExistingTrashEntry_AutoSuffixes()
        {
            var libraryRoot = _dir;
            var raw = WriteFile("photo.dng", "second delete");
            var fake = new FakeRecycleBinService { Succeeds = false };
            Directory.CreateDirectory(Path.Combine(libraryRoot, ".maple", "trash"));
            File.WriteAllText(Path.Combine(libraryRoot, ".maple", "trash", "photo.dng"), "first delete");

            var outcome = await LocalFileOperations.TrashAsync(raw, libraryRoot, fake);

            Assert.Equal(Path.Combine(libraryRoot, ".maple", "trash", "photo.1.dng"), outcome.PrimaryPath);
            Assert.Equal("first delete", File.ReadAllText(Path.Combine(libraryRoot, ".maple", "trash", "photo.dng")));
            Assert.Equal("second delete", File.ReadAllText(outcome.PrimaryPath));
        }
    }
}

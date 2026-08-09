// TrashCollisionRestoreRoundTripTests — #2743 review finding: a trash-side
// collision (two photos, same original folder + name, trashed one after
// the other) auto-suffixes the SECOND one's trash-side basename
// (LocalFileOperations.Trash.cs's TrashToMapleFolderAsync), and restoring
// by inverting the trash path alone used to treat that suffixed name as if
// it had always been the real one — silently renaming the photo on
// restore. The fix (TrashSelectionLogic.ApplyOneAsync writing an
// `.origpath` marker at trash time, LocalFileOperations.TrashRestore.cs
// preferring it) is exercised here end to end: trash A, trash B (same
// name), restore both, and confirm BOTH come back under their true
// original name — never under a name that still carries the trash-side
// `.1` collision suffix.

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class TrashCollisionRestoreRoundTripTests : IDisposable
    {
        private readonly string _dir;

        public TrashCollisionRestoreRoundTripTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-trash-collision-restore-" + Guid.NewGuid().ToString("N"));
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
        public async Task TrashTwoSameNamedPhotos_ThenRestoreBoth_BothRecoverTheirTrueOriginalName()
        {
            var libraryRoot = _dir;
            // Succeeds = false forces the `.maple/trash` fallback for both —
            // the only branch this bug lives in (the Recycle Bin has its
            // own namespace and never collides with the library).
            var fake = new FakeRecycleBinService { Succeeds = false };

            // Photo A, trashed first — lands at .maple/trash/Album/photo.dng.
            var photoA = WriteFile(Path.Combine("Album", "photo.dng"), "first photo");
            var itemA = new TrashSourceItem(photoA, photoA, "photo.dng");
            var outcomesA = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { itemA }, _ => libraryRoot, fake);
            var trashedA = Assert.Single(outcomesA);
            Assert.Equal(TrashOutcomeKind.Trashed, trashedA.Kind);
            Assert.Equal(TrashDestinationKind.MapleTrashFolder, trashedA.DestinationKind);

            // A new, different photo — same original folder, same original
            // name — trashed second. Collides with A's trash-side file, so
            // TrashToMapleFolderAsync auto-suffixes it to photo.1.dng.
            var photoB = WriteFile(Path.Combine("Album", "photo.dng"), "second, different photo");
            var itemB = new TrashSourceItem(photoB, photoB, "photo.dng");
            var outcomesB = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { itemB }, _ => libraryRoot, fake);
            var trashedB = Assert.Single(outcomesB);
            Assert.Equal(TrashOutcomeKind.Trashed, trashedB.Kind);
            Assert.Equal(TrashDestinationKind.MapleTrashFolder, trashedB.DestinationKind);

            var trashDir = Path.Combine(libraryRoot, ".maple", "trash", "Album");
            var trashedAPath = Path.Combine(trashDir, "photo.dng");
            var trashedBPath = Path.Combine(trashDir, "photo.1.dng");
            Assert.True(File.Exists(trashedAPath));
            Assert.True(File.Exists(trashedBPath), "the collision must have actually happened for this test to be meaningful");
            Assert.Equal("first photo", File.ReadAllText(trashedAPath));
            Assert.Equal("second, different photo", File.ReadAllText(trashedBPath));

            // Restore A: its original spot is free, so it goes straight back.
            var restoredA = await LocalFileOperations.RestoreFromMapleTrashAsync(trashedAPath, libraryRoot);
            Assert.Equal(Path.Combine(libraryRoot, "Album", "photo.dng"), restoredA.PrimaryPath);
            Assert.Equal("first photo", File.ReadAllText(restoredA.PrimaryPath));

            // Restore B: WITHOUT the fix, this would incorrectly target
            // "Album/photo.1.dng" (inferred straight from the trash-side
            // suffixed name) and land there permanently. WITH the fix, its
            // recorded original name is "Album/photo.dng" — same as A's —
            // so it collides with A's just-restored file and gets the
            // ordinary restore-collision suffix instead.
            var restoredB = await LocalFileOperations.RestoreFromMapleTrashAsync(trashedBPath, libraryRoot);
            Assert.Equal(Path.Combine(libraryRoot, "Album", "photo.restored.dng"), restoredB.PrimaryPath);
            Assert.Equal("second, different photo", File.ReadAllText(restoredB.PrimaryPath));

            // Never the bug's wrong outcome: B permanently wearing the
            // trash-side collision suffix as if it were its real name.
            Assert.False(File.Exists(Path.Combine(libraryRoot, "Album", "photo.1.dng")));
        }

        [Fact]
        public async Task TrashTwoSameNamedPhotos_OrigpathMarkersRecordTheSameTrueOriginalRelativePath()
        {
            var libraryRoot = _dir;
            var fake = new FakeRecycleBinService { Succeeds = false };

            var photoA = WriteFile(Path.Combine("Album", "photo.dng"), "first");
            await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(photoA, photoA, "photo.dng") }, _ => libraryRoot, fake);

            var photoB = WriteFile(Path.Combine("Album", "photo.dng"), "second");
            await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(photoB, photoB, "photo.dng") }, _ => libraryRoot, fake);

            var trashDir = Path.Combine(libraryRoot, ".maple", "trash", "Album");
            var expectedRelative = Path.Combine("Album", "photo.dng");

            Assert.Equal(expectedRelative,
                LocalFileOperations.ComputeOriginalRelativePath(Path.Combine(trashDir, "photo.dng"), libraryRoot));
            Assert.Equal(expectedRelative,
                LocalFileOperations.ComputeOriginalRelativePath(Path.Combine(trashDir, "photo.1.dng"), libraryRoot));

            // The naive inversion (no marker consulted) is what the review
            // caught: for the SECOND item it disagrees with the recorded
            // truth, because the trash-side name itself carries the
            // collision suffix.
            Assert.Equal(Path.Combine("Album", "photo.1.dng"),
                LocalFileOperations.InferOriginalRelativePath(Path.Combine(trashDir, "photo.1.dng"), libraryRoot));
        }
    }
}

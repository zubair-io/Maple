// RelocateCollisionTests — real temp directories, real files (CLAUDE.md:
// "No mocks for the sidecar layer in tests"). Covers the three
// `CollisionPolicy` values against a destination that's already occupied
// (issue #2632).

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RelocateCollisionTests : IDisposable
    {
        private readonly string _dir;

        public RelocateCollisionTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-relocate-collision-" + Guid.NewGuid().ToString("N"));
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
        public async Task AutoSuffix_PicksNextFreeNumberedSibling()
        {
            var src = WriteFile("in\\photo.dng", "source bytes");
            Directory.CreateDirectory(Path.Combine(_dir, "out"));
            WriteFile("out\\photo.dng", "occupant");

            var outcome = await LocalFileOperations.RelocateAsync(
                src, Path.Combine(_dir, "out"), null, RelocateMode.Copy, CollisionPolicy.AutoSuffix);

            Assert.True(outcome.RenamedDueToCollision);
            Assert.Equal(Path.Combine(_dir, "out", "photo.1.dng"), outcome.PrimaryPath);
            Assert.Equal("source bytes", File.ReadAllText(outcome.PrimaryPath));
            Assert.Equal("occupant", File.ReadAllText(Path.Combine(_dir, "out", "photo.dng"))); // untouched
        }

        [Fact]
        public async Task Fail_ThrowsDestinationExistsAndLeavesBothFilesUntouched()
        {
            var src = WriteFile("in\\photo.dng", "source bytes");
            Directory.CreateDirectory(Path.Combine(_dir, "out"));
            var occupant = WriteFile("out\\photo.dng", "occupant");

            var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateAsync(
                    src, Path.Combine(_dir, "out"), null, RelocateMode.Move, CollisionPolicy.Fail));

            Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
            Assert.True(File.Exists(src));
            Assert.Equal("occupant", File.ReadAllText(occupant));
        }

        [Fact]
        public async Task Replace_OverwritesExistingDestinationAndItsSidecar()
        {
            var src = WriteFile("in\\photo.dng", "new bytes");
            WriteFile("in\\photo.xmp", "new sidecar");
            Directory.CreateDirectory(Path.Combine(_dir, "out"));
            WriteFile("out\\photo.dng", "old occupant");
            WriteFile("out\\photo.xmp", "old sidecar");

            var outcome = await LocalFileOperations.RelocateAsync(
                src, Path.Combine(_dir, "out"), null, RelocateMode.Move, CollisionPolicy.Replace);

            Assert.False(outcome.RenamedDueToCollision);
            Assert.Equal("new bytes", File.ReadAllText(Path.Combine(_dir, "out", "photo.dng")));
            Assert.Equal("new sidecar", File.ReadAllText(Path.Combine(_dir, "out", "photo.xmp")));
            Assert.False(File.Exists(src)); // move mode: source deleted
        }

        [Fact]
        public async Task AutoSuffix_MidBatchSelfCollisionAlsoSuffixes()
        {
            // Two sequential relocates into the same folder with the same
            // basename must not collide with EACH OTHER, matching the
            // design doc's "a shared-destination template can collide with
            // itself mid-batch" note for batch rename.
            var srcA = WriteFile("in\\a\\shot.dng", "A");
            var srcB = WriteFile("in\\b\\shot.dng", "B");
            var outDir = Path.Combine(_dir, "out");

            var first = await LocalFileOperations.RelocateAsync(srcA, outDir, "shot.dng", RelocateMode.Copy, CollisionPolicy.AutoSuffix);
            var second = await LocalFileOperations.RelocateAsync(srcB, outDir, "shot.dng", RelocateMode.Copy, CollisionPolicy.AutoSuffix);

            Assert.Equal(Path.Combine(outDir, "shot.dng"), first.PrimaryPath);
            Assert.Equal(Path.Combine(outDir, "shot.1.dng"), second.PrimaryPath);
            Assert.Equal("A", File.ReadAllText(first.PrimaryPath));
            Assert.Equal("B", File.ReadAllText(second.PrimaryPath));
        }
    }
}

// RawJpegStackRelocateTests — a stacked RAW+JPEG tile moved, copied and
// renamed as one unit (#5050, #5848). Real temp directories, real files. One
// tile is two file operations: either both files land, or the sources and
// everything already at the destination stay exactly as they were.

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegStackRelocateTests : IDisposable
    {
        private readonly string _dir;

        public RawJpegStackRelocateTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-stack-relocate-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(P("src"));
            Directory.CreateDirectory(P("dest"));
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string P(params string[] parts) => Path.Combine(_dir, Path.Combine(parts));

        private string Write(string content, params string[] parts)
        {
            var full = P(parts);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        private string[] Names(string folder) =>
            Directory.EnumerateFiles(P(folder)).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToArray()!;

        private void AssertContent(string expected, params string[] parts) =>
            Assert.Equal(expected, File.ReadAllText(P(parts)));

        private (string Raw, string Jpeg) WritePair(string sidecar = "<edits/>")
        {
            var raw = Write("raw", "src", "IMG_1.CR3");
            var jpeg = Write("jpeg", "src", "IMG_1.JPG");
            Write(sidecar, "src", "IMG_1.xmp");
            return (raw, jpeg);
        }

        [Fact]
        public async Task Move_CarriesTheJpegAndTheSharedSidecar_AndLeavesNothingBehind()
        {
            var (raw, jpeg) = WritePair();

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.Equal(P("dest", "IMG_1.CR3"), outcome.PrimaryPath);
            Assert.Equal(P("dest", "IMG_1.JPG"), outcome.CompanionPath);
            Assert.False(outcome.RenamedDueToCollision);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("dest"));
            AssertContent("raw", "dest", "IMG_1.CR3");
            AssertContent("jpeg", "dest", "IMG_1.JPG");
            AssertContent("<edits/>", "dest", "IMG_1.xmp");
            Assert.Empty(Names("src"));
        }

        [Fact]
        public async Task Move_WithoutASidecar_MovesBothFiles()
        {
            var raw = Write("raw", "src", "IMG_1.CR3");
            var jpeg = Write("jpeg", "src", "IMG_1.JPG");

            await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG" }, Names("dest"));
            Assert.Empty(Names("src"));
        }

        [Fact]
        public async Task Move_LeavesTheSidecarForAThirdSameStemPhoto()
        {
            var (raw, jpeg) = WritePair();
            Write("heic", "src", "IMG_1.HEIC");

            await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.Equal(new[] { "IMG_1.HEIC", "IMG_1.xmp" }, Names("src"));
            AssertContent("<edits/>", "src", "IMG_1.xmp");
            AssertContent("<edits/>", "dest", "IMG_1.xmp");
        }

        [Fact]
        public async Task Copy_DuplicatesBothFiles_AndKeepsTheSources()
        {
            var (raw, jpeg) = WritePair();

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("dest"), null, RelocateMode.Copy, CollisionPolicy.Fail);

            Assert.Equal(P("dest", "IMG_1.JPG"), outcome.CompanionPath);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("dest"));
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("src"));
        }

        [Fact]
        public async Task Rename_TakesTheJpegToTheRawsNewStem_WithItsOwnExtension()
        {
            var (raw, jpeg) = WritePair();

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("src"), "Trip.CR3", RelocateMode.Move, CollisionPolicy.Fail);

            Assert.Equal(P("src", "Trip.CR3"), outcome.PrimaryPath);
            Assert.Equal(P("src", "Trip.JPG"), outcome.CompanionPath);
            Assert.Equal(new[] { "Trip.CR3", "Trip.JPG", "Trip.xmp" }, Names("src"));
            AssertContent("raw", "src", "Trip.CR3");
            AssertContent("jpeg", "src", "Trip.JPG");
            AssertContent("<edits/>", "src", "Trip.xmp");
        }

        [Fact]
        public async Task Rename_OfTheExtensionOnly_LeavesTheJpegAndTheSidecarInPlace()
        {
            var (raw, jpeg) = WritePair();

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("src"), "IMG_1.DNG", RelocateMode.Move, CollisionPolicy.Fail);

            Assert.Equal(jpeg, outcome.CompanionPath);
            Assert.Equal(new[] { "IMG_1.DNG", "IMG_1.JPG", "IMG_1.xmp" }, Names("src"));
            AssertContent("<edits/>", "src", "IMG_1.xmp");
        }

        [Fact]
        public async Task Rename_ThatDiffersOnlyInCase_RecasesBothFilesAndTheSidecar()
        {
            var raw = Write("raw", "src", "img_1.cr3");
            var jpeg = Write("jpeg", "src", "img_1.jpg");
            Write("<edits/>", "src", "img_1.xmp");
            if (!File.Exists(P("src", "IMG_1.CR3")))
                return;

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("src"), "IMG_1.cr3", RelocateMode.Move, CollisionPolicy.Fail);

            Assert.Equal(P("src", "IMG_1.jpg"), outcome.CompanionPath);
            Assert.Equal(new[] { "IMG_1.cr3", "IMG_1.jpg", "IMG_1.xmp" }, Names("src"));
            AssertContent("raw", "src", "IMG_1.cr3");
            AssertContent("jpeg", "src", "IMG_1.jpg");
            AssertContent("<edits/>", "src", "IMG_1.xmp");
        }

        [Fact]
        public async Task Fail_WhenOnlyTheJpegNameIsTaken_NamesTheJpegAndMovesNothing()
        {
            var (raw, jpeg) = WritePair();
            Write("other jpeg", "dest", "IMG_1.JPG");

            var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateStackAsync(
                    raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.Fail));

            Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
            Assert.Contains(P("dest", "IMG_1.JPG"), ex.Message);
            Assert.Equal(new[] { "IMG_1.JPG" }, Names("dest"));
            AssertContent("other jpeg", "dest", "IMG_1.JPG");
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("src"));
        }

        [Fact]
        public async Task Fail_WhenTheRawNameIsTaken_MovesNothing()
        {
            var (raw, jpeg) = WritePair();
            Write("other raw", "dest", "IMG_1.CR3");

            var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateStackAsync(
                    raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.Fail));

            Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
            Assert.Equal(new[] { "IMG_1.CR3" }, Names("dest"));
            AssertContent("other raw", "dest", "IMG_1.CR3");
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("src"));
        }

        [Fact]
        public async Task Replace_ReplacesTheRawAndItsSidecar_AndTheJpegFollows()
        {
            var (raw, jpeg) = WritePair();
            Write("old raw", "dest", "IMG_1.CR3");
            Write("<old/>", "dest", "IMG_1.xmp");

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.Replace);

            Assert.Equal(P("dest", "IMG_1.JPG"), outcome.CompanionPath);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("dest"));
            AssertContent("raw", "dest", "IMG_1.CR3");
            AssertContent("jpeg", "dest", "IMG_1.JPG");
            AssertContent("<edits/>", "dest", "IMG_1.xmp");
            Assert.Empty(Names("src"));
        }

        [Fact]
        public async Task Replace_NeverReachesTheJpeg_ATakenJpegNameRefusesThePair()
        {
            var (raw, jpeg) = WritePair();
            Write("old raw", "dest", "IMG_1.CR3");
            Write("old jpeg", "dest", "IMG_1.JPG");
            Write("<old/>", "dest", "IMG_1.xmp");

            var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateStackAsync(
                    raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.Replace));

            Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
            Assert.Contains(P("dest", "IMG_1.JPG"), ex.Message);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("dest"));
            AssertContent("old raw", "dest", "IMG_1.CR3");
            AssertContent("old jpeg", "dest", "IMG_1.JPG");
            AssertContent("<old/>", "dest", "IMG_1.xmp");
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("src"));
        }

        [Fact]
        public async Task Replace_WhenTheJpegCannotFollow_PutsBackWhatTheRawDisplaced()
        {
            var raw = Write("raw", "src", "IMG_1.CR3");
            var jpeg = Write("jpeg", "src", "IMG_1.jpg");
            Write("<edits/>", "src", "IMG_1.xmp");
            Write("<someone else's edits/>", "dest", "Trip.xmp");

            await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateStackAsync(
                    raw, jpeg, P("dest"), "Trip.jpg", RelocateMode.Move, CollisionPolicy.Replace));

            Assert.Equal(new[] { "Trip.xmp" }, Names("dest"));
            AssertContent("<someone else's edits/>", "dest", "Trip.xmp");
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.jpg", "IMG_1.xmp" }, Names("src"));
            AssertContent("raw", "src", "IMG_1.CR3");
            AssertContent("jpeg", "src", "IMG_1.jpg");
            AssertContent("<edits/>", "src", "IMG_1.xmp");
        }

        [Fact]
        public async Task Replace_NeverWritesTheRawOverItsOwnJpeg()
        {
            var (raw, jpeg) = WritePair();

            var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateStackAsync(
                    raw, jpeg, P("src"), "IMG_1.JPG", RelocateMode.Move, CollisionPolicy.Replace));

            Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("src"));
            AssertContent("raw", "src", "IMG_1.CR3");
            AssertContent("jpeg", "src", "IMG_1.JPG");
        }

        [Fact]
        public async Task KeepBoth_WhenOnlyTheJpegNameIsTaken_MovesBothToOneFreeStem()
        {
            var (raw, jpeg) = WritePair();
            Write("other jpeg", "dest", "IMG_1.JPG");

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.AutoSuffix);

            Assert.True(outcome.RenamedDueToCollision);
            Assert.Equal(P("dest", "IMG_1.1.CR3"), outcome.PrimaryPath);
            Assert.Equal(P("dest", "IMG_1.1.JPG"), outcome.CompanionPath);
            Assert.Equal(new[] { "IMG_1.1.CR3", "IMG_1.1.JPG", "IMG_1.1.xmp", "IMG_1.JPG" }, Names("dest"));
            AssertContent("other jpeg", "dest", "IMG_1.JPG");
            Assert.Empty(Names("src"));
        }

        [Fact]
        public async Task KeepBoth_WhenOnlyTheSidecarNameIsTaken_MovesBothToOneFreeStem()
        {
            var (raw, jpeg) = WritePair();
            Write("<someone else's edits/>", "dest", "IMG_1.xmp");

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.AutoSuffix);

            Assert.Equal(P("dest", "IMG_1.1.CR3"), outcome.PrimaryPath);
            Assert.Equal(new[] { "IMG_1.1.CR3", "IMG_1.1.JPG", "IMG_1.1.xmp", "IMG_1.xmp" }, Names("dest"));
            AssertContent("<someone else's edits/>", "dest", "IMG_1.xmp");
            AssertContent("<edits/>", "dest", "IMG_1.1.xmp");
        }

        [Fact]
        public async Task KeepBoth_SkipsAStemWhoseJpegNameIsTaken()
        {
            var (raw, jpeg) = WritePair();
            Write("other raw", "dest", "IMG_1.CR3");
            Write("other jpeg", "dest", "IMG_1.1.JPG");

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.AutoSuffix);

            Assert.Equal(P("dest", "IMG_1.2.CR3"), outcome.PrimaryPath);
            Assert.Equal(P("dest", "IMG_1.2.JPG"), outcome.CompanionPath);
            AssertContent("other raw", "dest", "IMG_1.CR3");
            AssertContent("other jpeg", "dest", "IMG_1.1.JPG");
        }

        [Fact]
        public async Task AMissingJpeg_RefusesThePairBeforeAnythingMoves()
        {
            var raw = Write("raw", "src", "IMG_1.CR3");

            var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateStackAsync(
                    raw, P("src", "IMG_1.JPG"), P("dest"), null, RelocateMode.Move, CollisionPolicy.AutoSuffix));

            Assert.Equal(FileOperationErrorKind.SourceMissing, ex.Kind);
            Assert.Equal(new[] { "IMG_1.CR3" }, Names("src"));
            Assert.Empty(Names("dest"));
        }
    }
}
